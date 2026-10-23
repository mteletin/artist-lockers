using AiTlt.Assets.Http;
using AiTlt.Identity;

namespace AiTlt.ArtistLockers.Hosting;

/// <summary>/media/{id} and /media/{id}/poster: the library's bytes, fetched from the gallery (ai-tlt-gallery). A published
/// asset is served to anyone; an unpublished one only to its signed-in owner, or to an identity admin. Range and conditional
/// requests pass through, so video seeks.</summary>
public static class MediaProxy
{
    public const string Path = "/media/";
    private static readonly string[] ResponseHeaders =
        ["Content-Type", "Content-Length", "Content-Range", "Content-Disposition", "Last-Modified", "ETag", "Accept-Ranges"];

    private delegate Task<AssetDeliveryResponse?> Fetch(AssetDeliveryClient client, Guid id, Guid? account, bool elevated,
        IReadOnlyDictionary<string, string[]> headers, CancellationToken cancellationToken);

    public static void MapMediaProxy(this WebApplication app)
    {
        // Media is not under /api: an <img> or <video> sends the cookie but no CSRF header, and the session check still runs.
        app.MapGet(Path + "{id:guid}", (Guid id, HttpContext http, AssetDeliveryClient client, CancellationToken cancellationToken) =>
            ServeAsync(id, http, client, (c, asset, account, elevated, headers, ct) => account is { } owner
                ? c.PreviewAsync(asset, owner, elevated, headers, ct) : c.PublicAsync(asset, headers, ct), cancellationToken));
        app.MapGet(Path + "{id:guid}/poster", (Guid id, HttpContext http, AssetDeliveryClient client, CancellationToken cancellationToken) =>
            ServeAsync(id, http, client, (c, asset, account, elevated, headers, ct) => account is { } owner
                ? c.PreviewPosterAsync(asset, owner, elevated, headers, ct) : c.PublicPosterAsync(asset, headers, ct), cancellationToken));
    }

    private static async Task<IResult> ServeAsync(Guid id, HttpContext http, AssetDeliveryClient client, Fetch fetch, CancellationToken cancellationToken)
    {
        var headers = AssetDeliveryClient.RequestHeaders.Where(name => http.Request.Headers.ContainsKey(name))
            .ToDictionary(name => name, name => http.Request.Headers[name].Select(value => value!).ToArray(), StringComparer.OrdinalIgnoreCase);
        try
        {
            var response = await fetch(client, id, null, false, headers, cancellationToken);
            // The session check put the account here only for a valid, enabled session. Elevated preview is asked for admins
            // only: the gallery grants it on the artistlockers's scope alone.
            if (response is null && ArtistLockersHost.SignedIn(http) is { } account)
            {
                response = await fetch(client, id, account.Id, false, headers, cancellationToken);
                if (response is null && AiTlt.Identity.ApplicationPermissions.Allows(account.Permissions, "accounts:manage"))
                    response = await fetch(client, id, account.Id, true, headers, cancellationToken);
            }
            return response is null ? Results.NotFound() : new MediaResult(response);
        }
        catch (AssetDeliveryException exception) { return Results.StatusCode(exception.IsTimeout ? 504 : 502); }
    }

    private sealed class MediaResult(AssetDeliveryResponse delivery) : IResult
    {
        public async Task ExecuteAsync(HttpContext http)
        {
            using (delivery)
            {
                var upstream = delivery.Response;
                http.Response.StatusCode = (int)upstream.StatusCode;
                foreach (var name in ResponseHeaders)
                    if (upstream.Headers.TryGetValues(name, out var values) || upstream.Content.Headers.TryGetValues(name, out values))
                        http.Response.Headers[name] = values.ToArray();
                http.Response.Headers.CacheControl = delivery.IsPublic ? "public, max-age=86400" : "private, no-store";
                try
                {
                    await using var body = await upstream.Content.ReadAsStreamAsync(delivery.CancellationToken);
                    await body.CopyToAsync(http.Response.Body, delivery.CancellationToken);
                }
                catch (Exception exception) when (exception is OperationCanceledException or IOException or HttpRequestException)
                { http.Abort(); } // Part of the body is already sent; it cannot become an error response now.
            }
        }
    }
}
