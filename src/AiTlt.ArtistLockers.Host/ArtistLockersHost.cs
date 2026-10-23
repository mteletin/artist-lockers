using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using AiTlt.Identity;
using AiTlt.Identity.Http;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;

namespace AiTlt.ArtistLockers.Hosting;

/// <summary>Where the artistlockers sends a member to sign in, and the callback identity sends them back to.</summary>
public sealed record ArtistLockersSignIn(string ClientId, string AuthorizeUrl, string CallbackUrl);

/// <summary>
/// artistlockers.ai-tlt.eu: the signed-in member's media library. It keeps no data of its own: identity signs members in and says who
/// they are, the gallery lists the library, serves the bytes and takes the member's uploads and edits, the tools list the
/// generation history, each called with the artistlockers's own platform-signed tokens.
/// </summary>
public static class ArtistLockersHost
{
    public const string CookieScheme = "AiTltArtistLockers";
    public const string CsrfHeader = "X-AiTlt-Request";
    public const string BrowserPolicy = "ArtistLockersBrowser";
    public const string WritePolicy = "ArtistLockersWrites";
    public const string AccountItem = "ai-tlt.artistlockers.account";
    public const string CallbackPath = "/auth/sso/callback";
    private const string IdentityDownItem = "ai-tlt.artistlockers.identity-down";
    private const string SignInCookie = "ai-tlt.artistlockers.signin";
    private static readonly TimeSpan SignInLifetime = TimeSpan.FromMinutes(10);
    /// <summary>The codes identity may send back; anything else reads as a failed Discord sign-in.</summary>
    private static readonly HashSet<string> SignInErrors = new(StringComparer.Ordinal) { "discord_auth", "account_unknown", "account_disabled" };
    private sealed record PendingSignIn(string State, string ReturnUrl, DateTimeOffset Started);

    public static void AddArtistLockersHost(this WebApplicationBuilder builder)
    {
        var options = builder.Configuration.GetSection("ArtistLockers").Get<ArtistLockersHostOptions>() ?? new();
        if (options.AccountCacheSeconds is < 0 or > 300) throw new InvalidOperationException("ArtistLockers:AccountCacheSeconds must be between 0 and 300.");
        if (options.UploadTimeoutSeconds is < 30 or > 3600) throw new InvalidOperationException("ArtistLockers:UploadTimeoutSeconds must be between 30 and 3600.");
        if (options.WritesPerHour is < 0 or > 10000) throw new InvalidOperationException("ArtistLockers:WritesPerHour must be between 0 and 10000 (0: no limit).");
        builder.Services.AddSingleton(options);
        builder.WebHost.ConfigureKestrel(kestrel =>
        {
            kestrel.AddServerHeader = false;
            kestrel.Limits.MaxRequestBodySize = 64 * 1024; // JSON bodies; the upload route raises its own limit.
        });
        builder.AddArtistLockersServices(options);

        var protection = builder.Services.AddDataProtection().SetApplicationName("ai-tlt-artistlockers");
        if (!string.IsNullOrWhiteSpace(options.KeysDirectory)) protection.PersistKeysToFileSystem(new DirectoryInfo(options.KeysDirectory));
        else if (!builder.Environment.IsDevelopment()) throw new InvalidOperationException("ArtistLockers:KeysDirectory is required.");

        // Identity signs members in; the artistlockers is its SSO client under the same id it signs its identity tokens with.
        var clientId = builder.Configuration["Identity:Signing:ClientId"];
        if (string.IsNullOrWhiteSpace(clientId)) throw new InvalidOperationException("Identity:Signing:ClientId is required.");
        builder.Services.AddSingleton(new ArtistLockersSignIn(clientId,
            SiteUrl(options.AccountsUrl, "ArtistLockers:AccountsUrl", builder.Environment.IsDevelopment()) + "/auth/sso",
            SiteUrl(options.PublicUrl, "ArtistLockers:PublicUrl", builder.Environment.IsDevelopment()) + CallbackPath));

        builder.Services.AddAuthentication(authentication =>
            {
                authentication.DefaultScheme = CookieScheme;
                authentication.DefaultChallengeScheme = CookieScheme;
            })
            .AddCookie(CookieScheme, cookie =>
            {
                cookie.Cookie.Name = "ai-tlt.artistlockers.session";
                cookie.Cookie.HttpOnly = true;
                cookie.Cookie.SameSite = SameSiteMode.Lax;
                cookie.Cookie.SecurePolicy = CookieSecurePolicy.Always;
                cookie.ExpireTimeSpan = TimeSpan.FromDays(14);
                cookie.SlidingExpiration = true;
                cookie.Events.OnRedirectToLogin = context =>
                {
                    // Identity being down is not a signed-out session: the page says so instead of offering sign-in.
                    if (context.HttpContext.Items.ContainsKey(IdentityDownItem)) return ApiErrors.WriteAsync(context.HttpContext, ApiErrors.IdentityUnavailable);
                    context.Response.StatusCode = 401;
                    return Task.CompletedTask;
                };
                cookie.Events.OnRedirectToAccessDenied = context => { context.Response.StatusCode = 403; return Task.CompletedTask; };
                cookie.Events.OnValidatePrincipal = ValidateSessionAsync;
            });

        builder.Services.AddAuthorization(authorization =>
            authorization.AddPolicy(BrowserPolicy, policy => policy.AddAuthenticationSchemes(CookieScheme).RequireAuthenticatedUser()));

        // Mobvision's asset write limit: per member, per hour, staff and listed accounts exempt. It runs after the session check,
        // which names the member.
        builder.Services.AddRateLimiter(limiter =>
        {
            limiter.OnRejected = (context, _) =>
            {
                if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
                    context.HttpContext.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
                return new ValueTask(ApiErrors.WriteAsync(context.HttpContext, ApiErrors.WriteLimited));
            };
            limiter.AddPolicy(WritePolicy, http => SignedIn(http) is not { } account || options.WritesPerHour == 0 || WriteLimitExempt(account, options)
                ? RateLimitPartition.GetNoLimiter("exempt")
                : RateLimitPartition.GetFixedWindowLimiter(account.Id.ToString(), _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = options.WritesPerHour, Window = TimeSpan.FromHours(1), QueueLimit = 0, AutoReplenishment = true
                }));
        });
    }

    private static bool WriteLimitExempt(Account account, ArtistLockersHostOptions options) => options.WriteLimitExemptAccountIds.Contains(account.Id)
        || options.WriteLimitExemptPermissions.Any(permission => ApplicationPermissions.Allows(account.Permissions, permission));

    public static void MapArtistLockersHost(this WebApplication app)
    {
        app.Use(async (http, next) =>
        {
            SecurityHeaders(http);
            // The artistlockers has no server-to-server surface of its own.
            if (http.Request.Path.StartsWithSegments("/internal"))
            {
                http.Response.StatusCode = 404;
                return;
            }
            await next(http);
        });

        app.UseAuthentication();
        app.Use(async (http, next) =>
        {
            if (http.Request.Path == "/codex.html" || http.Request.Path == "/tools.html")
            {
                http.Response.Headers.CacheControl = "no-store";
                var account = SignedIn(http);
                if (account is null) { http.Response.Redirect("/auth/signin?returnUrl=" + Uri.EscapeDataString(http.Request.Path + http.Request.QueryString)); return; }
                var permission = http.Request.Path == "/codex.html" ? "codex:access" : "studio:access";
                if (!ApplicationPermissions.Allows(account.Permissions, permission)) { http.Response.StatusCode = 403; return; }
            }
            await next(http);
        });
        app.UseDefaultFiles();
        app.UseStaticFiles(new StaticFileOptions
        {
            // No build step and no versioned names: every file revalidates (ETag), so a deploy is seen at once.
            OnPrepareResponse = context => context.Context.Response.Headers.CacheControl = "no-cache"
        });

        app.MapGet("/health/live", () => Results.Ok(new { status = "up" }));
        app.MapGet("/health/ready", async (IHttpClientFactory clients, CancellationToken cancellationToken) =>
        {
            var identity = await UpAsync(clients.CreateClient(ArtistLockersServices.Identity), cancellationToken);
            var gallery = await UpAsync(clients.CreateClient(ArtistLockersServices.Gallery), cancellationToken);
            var tools = await UpAsync(clients.CreateClient(ArtistLockersServices.Tools), cancellationToken);
            var codex = await UpAsync(clients.CreateClient(ArtistLockersServices.Codex), cancellationToken);
            return identity && gallery && tools && codex ? Results.Ok(new { status = "ready" })
                : Results.Json(new { status = "dependency_unavailable", identity, gallery, tools, codex }, statusCode: 503);
        });

        app.UseWhen(http => http.Request.Path.StartsWithSegments("/api") || http.Request.Path.StartsWithSegments("/auth"), branch =>
        {
            branch.Use(ApiErrors.HandleAsync);
            branch.Use(async (http, next) =>
            {
                if (!CsrfAllowed(http))
                {
                    await ApiErrors.WriteAsync(http, ApiErrors.CsrfRejected);
                    return;
                }
                http.Response.Headers.CacheControl = "no-store";
                await next(http);
            });
        });

        app.UseAuthorization();
        app.UseRateLimiter();

        app.MapGet("/auth/signin", StartSignIn);
        app.MapGet(CallbackPath, FinishSignInAsync);
        app.MapPost("/auth/signout", async (HttpContext http) =>
        {
            await http.SignOutAsync(CookieScheme);
            return Results.NoContent();
        });

        LibraryEndpoints.Map(app);
        LibraryWriteEndpoints.Map(app);
        GenerationEndpoints.Map(app);
        ToolsEndpoints.Map(app);
        CodexEndpoints.Map(app);
        ProfileEndpoints.Map(app);
        app.MapMediaProxy();

        // The UI routes by hash, but a deep link to any other page path still gets the app; API paths keep their 404.
        var index = app.Environment.WebRootFileProvider.GetFileInfo("index.html");
        app.MapFallback(async http =>
        {
            var path = http.Request.Path;
            if (path.StartsWithSegments("/api") || path.StartsWithSegments("/auth") || path.StartsWithSegments("/health")
                || path.StartsWithSegments("/media") || !index.Exists || !(HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method)))
            {
                http.Response.StatusCode = 404;
                return;
            }
            http.Response.ContentType = "text/html; charset=utf-8";
            http.Response.Headers.CacheControl = "no-cache";
            await http.Response.SendFileAsync(index);
        });
    }

    /// <summary>The account of a valid, enabled session; the session check put it here.</summary>
    public static Account? SignedIn(HttpContext http) => http.Items[AccountItem] as Account;

    private static async Task<bool> UpAsync(HttpClient client, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            using var response = await client.GetAsync("health/live", deadline.Token);
            return response.IsSuccessStatusCode;
        }
        catch (Exception exception) when (exception is HttpRequestException or OperationCanceledException) { return false; }
    }

    /// <summary>Sends the browser to identity's sign-in with a fresh state, kept with the page to return to in a protected,
    /// short-lived cookie that only the callback sees. A member already signed in at identity comes straight back.</summary>
    private static IResult StartSignIn(string? returnUrl, HttpContext http, ArtistLockersSignIn signIn, IDataProtectionProvider protection)
    {
        var state = Base64Url(RandomNumberGenerator.GetBytes(32));
        var pending = JsonSerializer.Serialize(new PendingSignIn(state, LocalReturnUrl(returnUrl), DateTimeOffset.UtcNow));
        http.Response.Cookies.Append(SignInCookie, SignInProtector(protection).Protect(pending), SignInCookieOptions(SignInLifetime));
        return Results.Redirect($"{signIn.AuthorizeUrl}?client_id={Uri.EscapeDataString(signIn.ClientId)}"
            + $"&redirect_uri={Uri.EscapeDataString(signIn.CallbackUrl)}&state={state}");
    }

    /// <summary>Identity's answer: a one-time code, redeemed server to server for the account, or an error code. Either way the
    /// state must match the one this browser was given, so nobody can sign a member into someone else's session.</summary>
    private static async Task<IResult> FinishSignInAsync(HttpContext http, ArtistLockersSignIn signIn, IDataProtectionProvider protection,
        IdentityAccountsClient identity, AccountDirectory accounts, ILoggerFactory logs)
    {
        var query = http.Request.Query;
        var pending = ReadPendingSignIn(http, protection);
        http.Response.Cookies.Delete(SignInCookie, SignInCookieOptions(null));
        if (pending is null || query["state"].Count != 1
            || !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(pending.State), Encoding.ASCII.GetBytes(query["state"].ToString())))
            return Results.Redirect("/?error=signin_expired");
        if (query["error"].ToString() is { Length: > 0 } error)
            return Results.Redirect("/?error=" + (SignInErrors.Contains(error) ? error : "discord_auth"));
        if (query["code"].ToString() is not { Length: > 0 and <= 128 } code) return Results.Redirect("/?error=signin_expired");

        Account? account;
        try
        {
            account = await identity.RedeemSignInAsync(code, signIn.CallbackUrl, http.RequestAborted);
        }
        catch (IdentityServiceException exception)
        {
            logs.CreateLogger("ArtistLockers.SignIn").LogWarning(exception, "Identity could not redeem a sign-in code.");
            return Results.Redirect("/?error=identity_unavailable");
        }
        if (account is null) return Results.Redirect("/?error=signin_expired");
        if (account.DisabledAt is not null) return Results.Redirect("/?error=account_disabled");
        if (!ApplicationPermissions.Allows(account.Permissions, "artistlockers:access")) return Results.Redirect("/?error=access_denied");
        accounts.Remember(account.Id, account);
        await http.SignInAsync(CookieScheme, SessionPrincipal(account));
        return Results.Redirect(pending.ReturnUrl);
    }

    private static PendingSignIn? ReadPendingSignIn(HttpContext http, IDataProtectionProvider protection)
    {
        if (http.Request.Cookies[SignInCookie] is not { Length: > 0 } cookie) return null;
        try
        {
            var pending = JsonSerializer.Deserialize<PendingSignIn>(SignInProtector(protection).Unprotect(cookie));
            return pending is not null && DateTimeOffset.UtcNow - pending.Started < SignInLifetime ? pending : null;
        }
        catch (Exception exception) when (exception is CryptographicException or JsonException) { return null; }
    }

    private static IDataProtector SignInProtector(IDataProtectionProvider protection) => protection.CreateProtector("ai-tlt.artistlockers.signin.v1");

    // Lax: identity sends the browser back with a top-level GET, which carries it.
    private static CookieOptions SignInCookieOptions(TimeSpan? maxAge) => new()
    {
        HttpOnly = true, Secure = true, SameSite = SameSiteMode.Lax, Path = CallbackPath, MaxAge = maxAge, IsEssential = true
    };

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>An absolute https site address without a trailing slash; development may use http on loopback.</summary>
    private static string SiteUrl(string value, string setting, bool development)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)
            || !(uri.Scheme == Uri.UriSchemeHttps || (development && uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
            throw new InvalidOperationException($"{setting} must be an absolute HTTPS address.");
        return value.TrimEnd('/');
    }

    public static ClaimsPrincipal SessionPrincipal(Account account) => new(new ClaimsIdentity(
        [new Claim("sub", account.Id.ToString()), new Claim("sv", account.SessionVersion.ToString(CultureInfo.InvariantCulture)),
         new Claim("name", account.DisplayName)], CookieScheme, "name", null));

    /// <summary>Re-reads the account from identity (cached briefly): a disabled account, a revoke or a role change (new session
    /// version) ends the session. While identity is unreachable the request is treated as signed out, but the cookie is kept.</summary>
    private static async Task ValidateSessionAsync(CookieValidatePrincipalContext context)
    {
        var principal = context.Principal;
        Account? account = null;
        if (Guid.TryParse(principal?.FindFirstValue("sub"), out var accountId))
        {
            try
            {
                account = await context.HttpContext.RequestServices.GetRequiredService<AccountDirectory>()
                    .GetAsync(accountId, context.HttpContext.RequestAborted);
            }
            catch (IdentityServiceException exception)
            {
                context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("ArtistLockers.Session")
                    .LogWarning(exception, "Identity could not confirm a session.");
                context.HttpContext.Items[IdentityDownItem] = true;
                context.RejectPrincipal();
                return;
            }
        }
        if (account is null || account.DisabledAt is not null || !ApplicationPermissions.Allows(account.Permissions, "artistlockers:access")
            || principal!.FindFirstValue("sv") != account.SessionVersion.ToString(CultureInfo.InvariantCulture))
        {
            context.RejectPrincipal();
            await context.HttpContext.SignOutAsync(CookieScheme);
            return;
        }
        context.HttpContext.Items[AccountItem] = account;
    }

    private static bool CsrfAllowed(HttpContext http)
    {
        var request = http.Request;
        if (HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method) || HttpMethods.IsOptions(request.Method)) return true;
        if (request.Headers[CsrfHeader] != "1") return false;
        var origin = request.Headers.Origin.ToString();
        if (origin.Length > 0 && !string.Equals(origin, $"{request.Scheme}://{request.Host}", StringComparison.OrdinalIgnoreCase)) return false;
        var site = request.Headers["Sec-Fetch-Site"].ToString();
        return site.Length == 0 || site == "same-origin";
    }

    private static string LocalReturnUrl(string? returnUrl) =>
        returnUrl is { Length: > 0 and < 2048 } && returnUrl[0] == '/' && !returnUrl.StartsWith("//", StringComparison.Ordinal)
            && !returnUrl.StartsWith("/\\", StringComparison.Ordinal) && !returnUrl.Any(char.IsControl)
            ? returnUrl : "/";

    private static void SecurityHeaders(HttpContext http)
    {
        var headers = http.Response.Headers;
        headers.ContentSecurityPolicy = "default-src 'self'; img-src 'self' https: data:; media-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            + "connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
        headers.XContentTypeOptions = "nosniff";
        headers.XFrameOptions = "DENY";
        headers["Referrer-Policy"] = "same-origin";
        headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()";
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
        headers.StrictTransportSecurity = "max-age=31536000";
    }
}
