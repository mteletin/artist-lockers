using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AiTlt.InternalAccess;
using Microsoft.AspNetCore.Http.Features;

namespace AiTlt.ArtistLockers.Hosting;

/// <summary>The Codex could not be reached or took too long; the browser sees a 503 or 504 with a code.</summary>
public sealed class CodexServiceException(bool timeout = false) : Exception("Codex unavailable.")
{
    public bool IsTimeout { get; } = timeout;
}

/// <summary>The browser's body passed the artistlockers's limit for a Codex call while it streamed through.</summary>
public sealed class CodexTooLargeException() : Exception("The request body is too large for the Codex.");

/// <summary>
/// Sends one browser request to the Codex (ai-tlt-codex) as the signed-in member: an actor token for <see cref="UseScope"/>
/// naming the member. The Codex decides who may open, edit, share and delete a page, who is staff for the storyboard, and keeps
/// the pages, shares, shots and takes; the artistlockers holds none of it.
/// </summary>
public sealed class CodexProxy(HttpClient http, InternalActorTokenIssuer issuer, TimeSpan timeout)
{
    public const string UseScope = "codex:use";
    public const string Prefix = "internal/v1/codex";

    /// <summary>Sends the request and returns the Codex's answer once its headers arrived; the caller streams the body and
    /// disposes it. The deadline covers the request body and the wait for headers, not the answer's body.</summary>
    public async Task<HttpResponseMessage> SendAsync(Guid account, HttpMethod method, string target, HttpContent? content,
        IEnumerable<(string Name, string[] Values)> headers, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, Prefix + target) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", issuer.Issue(account, UseScope));
        foreach (var (name, values) in headers) request.Headers.TryAddWithoutValidation(name, values);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(timeout);
        try { return await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new CodexServiceException(timeout: true); }
        // The browser's body grew past its limit while it was streamed through: that is the member's, not the Codex's.
        catch (HttpRequestException exception) when (TooLarge(exception)) { throw new CodexTooLargeException(); }
        catch (HttpRequestException) { throw new CodexServiceException(); }
    }

    private static bool TooLarge(Exception? exception)
    {
        for (; exception is not null; exception = exception.InnerException)
            if (exception is BadHttpRequestException { StatusCode: StatusCodes.Status413PayloadTooLarge }) return true;
        return false;
    }
}

/// <summary>
/// /api/v1/codex/{**path}: the Codex, forwarded to ai-tlt-codex's /internal/v1/codex for any signed-in member. The artistlockers checks
/// no roles of its own: the Codex answers 403 to an account it does not know, keeps pages private to their owner and shares, and
/// keeps the storyboard to staff. Its MCP routes are not offered here (they belong to the MCP connector, not the page). Bodies
/// stream both ways; the Codex's refusals come back as <c>{code, message}</c>, keeping its own words.
/// </summary>
public static class CodexEndpoints
{
    /// <summary>A page save: the Codex's 3 MB document limit (CodexRules.MaxDocBytes) plus the JSON around it.</summary>
    public const long BodyLimit = 3L * 1024 * 1024 + 65536;
    /// <summary>The Codex's own words for a page over its limit.</summary>
    public const string TooLargeWords = "This page is too large. Split it into sub-pages.";
    private const int RefusalLimit = 64 * 1024;
    private static readonly string[] Methods = ["GET", "POST", "PUT", "DELETE"];
    private static readonly string[] RequestHeaders = ["Range", "If-Range", "If-None-Match", "If-Modified-Since", "Accept"];
    private static readonly string[] ResponseHeaders = ["Content-Type", "Content-Length", "Content-Disposition", "Content-Range",
        "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control", "X-Content-Type-Options", "Content-Security-Policy"];

    public static void Map(WebApplication app)
    {
        app.MapMethods("/api/codex", Methods, ForwardAsync).RequireAuthorization(ArtistLockersHost.BrowserPolicy);
        app.MapMethods("/api/codex/{**path}", Methods, ForwardAsync).RequireAuthorization(ArtistLockersHost.BrowserPolicy);
    }

    /// <summary>The Codex path for a artistlockers path: each segment escaped again, nothing that climbs out of the Codex's routes, and
    /// never its MCP routes (the MCP connector reaches those with its own grant). Null: refused.</summary>
    internal static string? Target(string path, string query)
    {
        if (path.Length == 0) return query;
        var segments = path.Split('/');
        if (segments.Any(segment => segment is "" or "." or "..") || string.Equals(segments[0], "mcp", StringComparison.OrdinalIgnoreCase)) return null;
        return "/" + string.Join('/', segments.Select(Uri.EscapeDataString)) + query;
    }

    private static async Task ForwardAsync(HttpContext http, CodexProxy codex, ILoggerFactory logs)
    {
        var account = ArtistLockersHost.SignedIn(http) ?? throw new InvalidOperationException("The session check did not run.");
        // Route values arrive decoded, so every segment is escaped again before it goes on.
        if (!AiTlt.Identity.ApplicationPermissions.Allows(account.Permissions, "codex:access")) { await ApiErrors.WriteAsync(http, ApiErrors.ToolsForbidden); return; }
        var path = http.Request.RouteValues["path"] as string ?? "";
        if (Target(path, http.Request.QueryString.Value ?? "") is not { } target)
        {
            await ApiErrors.WriteAsync(http, ApiErrors.NotFound);
            return;
        }
        var method = http.Request.Method;
        if (http.Request.ContentLength > BodyLimit)
        {
            await TooLargeAsync(http);
            return;
        }
        if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } size) size.MaxRequestBodySize = BodyLimit;

        HttpContent? content = null;
        if (http.Request.ContentLength > 0 || http.Request.Headers.TransferEncoding.Count > 0)
        {
            content = new StreamContent(http.Request.Body);
            if (http.Request.ContentType is { } type) content.Headers.TryAddWithoutValidation("Content-Type", type);
            if (http.Request.ContentLength is { } length) content.Headers.ContentLength = length;
        }
        var headers = RequestHeaders.Where(name => http.Request.Headers.ContainsKey(name))
            .Select(name => (name, http.Request.Headers[name].Where(value => value is not null).Select(value => value!).ToArray()));

        HttpResponseMessage sent;
        try { sent = await codex.SendAsync(account.Id, new HttpMethod(method), target, content, headers, http.RequestAborted); }
        catch (CodexTooLargeException)
        {
            await TooLargeAsync(http);
            return;
        }
        using var answer = sent;
        var status = (int)answer.StatusCode;
        if (answer.IsSuccessStatusCode || status is 304 or 416)
        {
            await PassAsync(http, answer);
            return;
        }
        switch (answer.StatusCode)
        {
            case HttpStatusCode.Unauthorized:
                // The Codex does not trust the artistlockers's key or audience: a deploy problem, not the member's.
                logs.CreateLogger("ArtistLockers").LogError("The Codex refused the artistlockers's token ({Method} {Path}); check Codex:Signing and the Codex's trusted clients.",
                    method, path);
                await ApiErrors.WriteAsync(http, ApiErrors.CodexMisconfigured);
                return;
            case HttpStatusCode.NotFound:
                await ApiErrors.WriteAsync(http, ApiErrors.NotFound);
                return;
        }
        var code = status switch
        {
            400 => ApiErrors.CodexRefused,
            403 => ApiErrors.CodexForbidden,
            409 => ApiErrors.CodexConflict,
            413 => ApiErrors.CodexTooLarge,
            422 => ApiErrors.CodexUnprocessable,
            503 => ApiErrors.CodexUnavailable,
            504 => ApiErrors.CodexTimeout,
            _ => null
        };
        if (code is null)
        {
            logs.CreateLogger("ArtistLockers").LogWarning("The Codex answered {Status} to {Method} {Path}.", status, method, path);
            await ApiErrors.WriteAsync(http, ApiErrors.CodexUnavailable);
            return;
        }
        // The Codex's refusals are written for people (read only, owner only, a page cap, sub-pages first): its words are kept.
        // A save over someone else's newer version says so with conflict:true, which the page answers with Reload or Overwrite.
        var (words, stale) = await RefusalAsync(answer, http.RequestAborted);
        await ApiErrors.Result(code == ApiErrors.CodexConflict && stale ? ApiErrors.CodexStale : code, words).ExecuteAsync(http);
    }

    private static Task TooLargeAsync(HttpContext http) =>
        ApiErrors.Result(ApiErrors.CodexTooLarge, TooLargeWords).ExecuteAsync(http);

    private static async Task PassAsync(HttpContext http, HttpResponseMessage answer)
    {
        var response = http.Response;
        response.StatusCode = (int)answer.StatusCode;
        // The Codex's own headers win over the artistlockers's defaults: an image or a take keeps its sandbox CSP and its caching.
        foreach (var name in ResponseHeaders)
            if (answer.Headers.TryGetValues(name, out var values) || answer.Content.Headers.TryGetValues(name, out values))
                response.Headers[name] = values.ToArray();
        if (!answer.Headers.Contains("Cache-Control")) response.Headers.CacheControl = "private, no-store";
        try
        {
            await using var body = await answer.Content.ReadAsStreamAsync(http.RequestAborted);
            await body.CopyToAsync(response.Body, http.RequestAborted);
        }
        catch (Exception exception) when (exception is OperationCanceledException or IOException or HttpRequestException)
        { http.Abort(); } // Part of the body may already be sent; it cannot become an error response now.
    }

    private static async Task<(string? Words, bool Stale)> RefusalAsync(HttpResponseMessage answer, CancellationToken ct)
    {
        try
        {
            if (answer.Content.Headers.ContentLength is > RefusalLimit) return (null, false);
            await using var body = await answer.Content.ReadAsStreamAsync(ct);
            var buffer = new byte[RefusalLimit];
            var length = 0;
            int count;
            while (length < buffer.Length && (count = await body.ReadAsync(buffer.AsMemory(length), ct)) != 0) length += count;
            if (length == 0 || length == buffer.Length) return (null, false);
            if (JsonNode.Parse(Encoding.UTF8.GetString(buffer, 0, length)) is not JsonObject error) return (null, false);
            var stale = error["conflict"] is JsonValue flag && flag.TryGetValue<bool>(out var conflict) && conflict;
            var words = error["error"] is JsonValue message && message.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text) ? text : null;
            return (words, stale);
        }
        catch (Exception exception) when (exception is JsonException or IOException or HttpRequestException) { return (null, false); }
    }
}
