using System.Net.Security;
using System.Security.Cryptography;
using AiTlt.Assets.Http;
using AiTlt.Identity;
using AiTlt.Identity.Http;
using AiTlt.InternalAccess;
using AiTlt.Jobs.Http;
using Microsoft.Extensions.Caching.Memory;

namespace AiTlt.ArtistLockers.Hosting;

/// <summary>The services behind the artistlockers: identity (accounts, sign-in), the gallery (the media library, its bytes and the
/// member's own uploads and edits), the tools (the generation history, the generators and their operation), the team board
/// (ai-tlt-teamboard: the team's tasks and epics) and the Codex (ai-tlt-codex: the story wiki and its storyboard). Each has its own audience, and the artistlockers its own key for each.</summary>
public static class ArtistLockersServices
{
    public const string Identity = "AiTltIdentity";
    public const string Gallery = "AiTltGallery";
    public const string Tools = "AiTltTools";
    public const string Board = "AiTltBoard";
    public const string Codex = "AiTltCodex";

    public static void AddArtistLockersServices(this WebApplicationBuilder builder, ArtistLockersHostOptions options)
    {
        var identity = Read(builder, "Identity");
        var gallery = Read(builder, "Gallery");
        var tools = Read(builder, "Tools");
        var codex = Read(builder, "Codex");
        builder.Services.AddMemoryCache();
        AddPinnedClient(builder, Identity, identity).AddTypedClient((http, services) =>
            new IdentityAccountsClient(http, services.GetRequiredKeyedService<InternalActorTokenIssuer>(Identity)));
        AddPinnedClient(builder, Gallery, gallery)
            .AddTypedClient((http, services) =>
            {
                var issuer = services.GetRequiredKeyedService<InternalActorTokenIssuer>(Gallery);
                return new AssetLibraryClient(http, issuer, issuer, TimeSpan.FromSeconds(gallery.TimeoutSeconds));
            })
            .AddTypedClient((http, services) =>
            {
                var issuer = services.GetRequiredKeyedService<InternalActorTokenIssuer>(Gallery);
                return new AssetDeliveryClient(http, issuer, issuer, TimeSpan.FromSeconds(gallery.TimeoutSeconds));
            })
            .AddTypedClient((http, services) =>
            {
                var issuer = services.GetRequiredKeyedService<InternalActorTokenIssuer>(Gallery);
                return new AssetWriteClient(http, issuer, issuer, TimeSpan.FromSeconds(gallery.TimeoutSeconds));
            })
            // An upload streams the browser's file through as it arrives, so it gets the upload deadline, not the gallery's.
            .AddTypedClient((http, services) =>
            {
                var issuer = services.GetRequiredKeyedService<InternalActorTokenIssuer>(Gallery);
                return new ArtistLockersUploads(new AssetWriteClient(http, issuer, issuer, TimeSpan.FromSeconds(options.UploadTimeoutSeconds)));
            });
        if (options.ToolsSlowTimeoutSeconds is < 1 or > 600) throw new InvalidOperationException("ArtistLockers:ToolsSlowTimeoutSeconds must be between 1 and 600.");
        AddPinnedClient(builder, Tools, tools)
            .AddTypedClient((http, services) => new GenerationClient(http,
                services.GetRequiredKeyedService<InternalActorTokenIssuer>(Tools), TimeSpan.FromSeconds(tools.TimeoutSeconds)))
            .AddTypedClient((http, services) => new ToolsProxy(http, services.GetRequiredKeyedService<InternalActorTokenIssuer>(Tools),
                TimeSpan.FromSeconds(tools.TimeoutSeconds), TimeSpan.FromSeconds(options.ToolsSlowTimeoutSeconds)));
        // The Codex answers as the member (codex:use only); a page save is its largest body, so one deadline serves every call.
        AddPinnedClient(builder, Codex, codex).AddTypedClient((http, services) => new CodexProxy(http,
            services.GetRequiredKeyedService<InternalActorTokenIssuer>(Codex), TimeSpan.FromSeconds(codex.TimeoutSeconds)));
        builder.Services.AddTransient<AccountDirectory>();
    }

    private static ServiceOptions Read(WebApplicationBuilder builder, string section)
    {
        var options = builder.Configuration.GetSection(section).Get<ServiceOptions>() ?? new();
        if (!Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var address) || !string.IsNullOrEmpty(address.UserInfo)
            || !string.IsNullOrEmpty(address.Query) || !string.IsNullOrEmpty(address.Fragment)
            || (address.Scheme != Uri.UriSchemeHttps && !(builder.Environment.IsDevelopment() && address.Scheme == Uri.UriSchemeHttp && address.IsLoopback)))
            throw new InvalidOperationException($"{section}:BaseUrl must be HTTPS; development permits HTTP loopback only.");
        if (options.TimeoutSeconds is < 1 or > 600) throw new InvalidOperationException($"{section}:TimeoutSeconds must be between 1 and 600.");
        var pin = options.CertificateSha256.Replace(":", "").Trim();
        if (pin.Length is not (0 or 64) || !pin.All(Uri.IsHexDigit)) throw new InvalidOperationException($"{section}:CertificateSha256 must be 64 hex digits.");
        options.CertificateSha256 = pin;
        // Validates the key now, so a bad setting stops the start instead of the first request.
        using (new InternalActorTokenIssuer(options.Signing)) { }
        return options;
    }

    private static IHttpClientBuilder AddPinnedClient(WebApplicationBuilder builder, string name, ServiceOptions options)
    {
        builder.Services.AddKeyedSingleton(name, (_, _) => new InternalActorTokenIssuer(options.Signing));
        return builder.Services.AddHttpClient(name, client =>
            {
                client.BaseAddress = new Uri(options.BaseUrl.TrimEnd('/') + "/");
                // Each client applies its own deadline; a streamed video must not be cut off by HttpClient's.
                client.Timeout = Timeout.InfiniteTimeSpan;
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                SslOptions = new SslClientAuthenticationOptions
                {
                    RemoteCertificateValidationCallback = (_, certificate, _, errors) => errors == SslPolicyErrors.None
                        || (options.CertificateSha256.Length > 0 && certificate is not null
                            && string.Equals(certificate.GetCertHashString(HashAlgorithmName.SHA256), options.CertificateSha256, StringComparison.OrdinalIgnoreCase))
                }
            });
    }
}

/// <summary>The gallery's write client with the upload deadline.</summary>
public sealed record ArtistLockersUploads(AssetWriteClient Client);

/// <summary>Accounts as identity has them now, cached briefly: a session is re-checked at most every
/// <see cref="ArtistLockersHostOptions.AccountCacheSeconds"/>, and owner names on shared media for five minutes.</summary>
public sealed class AccountDirectory(IdentityAccountsClient identity, IMemoryCache cache, ArtistLockersHostOptions options)
{
    private static readonly TimeSpan NameLifetime = TimeSpan.FromMinutes(5);
    private sealed record AccountKey(Guid Id);
    private sealed record NameKey(Guid Id);

    public async Task<Account?> GetAsync(Guid accountId, CancellationToken cancellationToken)
    {
        if (cache.TryGetValue(new AccountKey(accountId), out Account? cached)) return cached;
        var account = await identity.GetAsync(accountId, cancellationToken);
        Remember(accountId, account);
        return account;
    }

    /// <summary>Zero seconds turns the cache off: every request asks identity.</summary>
    public void Remember(Guid accountId, Account? account)
    {
        if (options.AccountCacheSeconds > 0) cache.Set(new AccountKey(accountId), account, TimeSpan.FromSeconds(options.AccountCacheSeconds));
    }

    /// <summary>Names for the given accounts; an account identity no longer has is left out.</summary>
    public async Task<IReadOnlyDictionary<Guid, AccountSummary>> NamesAsync(IEnumerable<Guid> accountIds, CancellationToken cancellationToken)
    {
        var names = new Dictionary<Guid, AccountSummary>();
        var missing = new List<Guid>();
        foreach (var id in accountIds.Distinct())
        {
            if (cache.TryGetValue(new NameKey(id), out AccountSummary? cached)) { if (cached is not null) names[id] = cached; }
            else missing.Add(id);
        }
        foreach (var batch in missing.Chunk(IdentityAccountsClient.MaximumLookup))
        {
            var found = (await identity.LookupAsync(batch, cancellationToken)).ToDictionary(summary => summary.Id);
            foreach (var id in batch)
            {
                found.TryGetValue(id, out var summary);
                cache.Set(new NameKey(id), summary, NameLifetime);
                if (summary is not null) names[id] = summary;
            }
        }
        return names;
    }
}
