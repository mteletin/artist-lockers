using System.Net.Http.Headers;
using System.Text.Json;
using AiTlt.InternalAccess;
using AiTlt.Identity.Http;

namespace AiTlt.ArtistLockers.Hosting;

/// <summary>Own creator information remains in Identity; the actor always comes from the validated product session.</summary>
public static class ProfileEndpoints
{
    public static void Map(WebApplication app)
    {
        var profile = app.MapGroup("/api/v1/profile").RequireAuthorization(ArtistLockersHost.BrowserPolicy);
        profile.MapGet("", (HttpContext http, CancellationToken _) => Forward(http, "profiles/me", "profiles:read:self"));
        profile.MapPut("", (HttpContext http, CancellationToken _) => Forward(http, "profiles/me", "profiles:write:self"));
        foreach (var collection in new[] { "artists", "personas" })
        {
            var target = collection;
            var scope = target + ":write:self";
            if (target == "artists") profile.MapGet("/artists", async (HttpContext http, IdentityAccountsClient identity, CancellationToken ct) =>
            {
                var own = await identity.ListOwnArtistsAsync(ArtistLockersHost.SignedIn(http)!.Id, ct);
                var lookup = await identity.LookupArtistsAsync(own.Select(artist => artist.Id).ToArray(), ct);
                return Results.Ok(new { items = own.Select(artist => new { artist.Id, artist.Name, artist.Slug, artist.Description,
                    artist.MainImageUrl, artist.SecondaryImageUrls, personaIds = lookup.Links.Where(link => link.ArtistId == artist.Id).Select(link => link.PersonaId).ToArray() }) });
            });
            else profile.MapGet("/" + target, (HttpContext http, CancellationToken _) => Forward(http, "me/" + target, scope));
            profile.MapPost("/" + target, (HttpContext http, CancellationToken _) => Forward(http, "me/" + target, scope));
            profile.MapPut("/" + target + "/{id:guid}", (Guid id, HttpContext http) => Forward(http, $"me/{target}/{id}", scope));
            profile.MapDelete("/" + target + "/{id:guid}", (Guid id, HttpContext http) => Forward(http, $"me/{target}/{id}", scope));
        }
        profile.MapPut("/artists/{id:guid}/personas", (Guid id, HttpContext http) => Forward(http, $"me/artists/{id}/personas", "artists:write:self"));
    }

    private static async Task<IResult> Forward(HttpContext http, string path, string scope)
    {
        var account = ArtistLockersHost.SignedIn(http)!;
        var services = http.RequestServices;
        var client = services.GetRequiredService<IHttpClientFactory>().CreateClient(ArtistLockersServices.Identity);
        var tokens = services.GetRequiredKeyedService<InternalActorTokenIssuer>(ArtistLockersServices.Identity);
        using var request = new HttpRequestMessage(new HttpMethod(http.Request.Method), "internal/v1/" + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", tokens.Issue(account.Id, scope));
        if (http.Request.ContentLength > 0 || http.Request.Headers.TransferEncoding.Count > 0)
        {
            request.Content = new StreamContent(http.Request.Body);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            using var response = await client.SendAsync(request, timeout.Token);
            if (response.StatusCode == System.Net.HttpStatusCode.NoContent) return Results.NoContent();
            if ((int)response.StatusCode is >= 300 and < 400) return Results.StatusCode(502);
            using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(timeout.Token), cancellationToken: timeout.Token);
            return Results.Json(json.RootElement.Clone(), statusCode: (int)response.StatusCode);
        }
        catch (Exception error) when (error is HttpRequestException or JsonException || error is OperationCanceledException && !http.RequestAborted.IsCancellationRequested)
        { return Results.Json(new { message = "Your profile could not be reached. Refresh before retrying a change." }, statusCode: 503); }
    }
}
