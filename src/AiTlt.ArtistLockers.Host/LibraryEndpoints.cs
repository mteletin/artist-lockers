using System.Globalization;
using AiTlt.Assets;
using AiTlt.Assets.Http;
using AiTlt.Identity;
using AiTlt.Identity.Http;

namespace AiTlt.ArtistLockers.Hosting;

public sealed record PersonDto(Guid Id, string DisplayName, string? AvatarUrl);
/// <summary>CanGenerate and CanOperate say which tool pages to offer; the tools routes check the same roles themselves.</summary>
public sealed record MeDto(PersonDto Account, IReadOnlyList<string> Roles, bool IsAdmin, bool WritesEnabled, string LegacySiteUrl,
    string AccountsUrl, bool CanGenerate, bool CanOperate)
{
    public IReadOnlyList<AccountAppLink> Apps { get; init; } = [];
    public IReadOnlyList<string> Permissions { get; init; } = [];
}
public sealed record DayDto(DateOnly Day, int Count);
public sealed record SummaryDto(IReadOnlyList<DayDto> Days, IReadOnlyList<string> Tags, int Total);
public sealed record ItemDto(Guid Id, string Filename, string? Description, string ContentType, string Kind, long SizeBytes,
    PersonDto? Owner, bool Published, bool Shared, bool Kit, IReadOnlyList<string> Tags, DateTimeOffset CreatedAt,
    double? DurationSeconds, int? Width, int? Height, string Url, string? PosterUrl, Guid? SourceAssetId, int? SourceFrame, bool Mine);
public sealed record PageDto(IReadOnlyList<ItemDto> Items, bool HasMore);

/// <summary>/api/v1: who is signed in, and the two libraries: the member's own media and the site's shared media. The member's
/// writes are <see cref="LibraryWriteEndpoints"/>.</summary>
public static class LibraryEndpoints
{
    private static readonly string[] Libraries = ["mine", "shared"];

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api/v1").RequireAuthorization(ArtistLockersHost.BrowserPolicy);

        api.MapGet("/me", async (HttpContext http, ArtistLockersHostOptions options, IdentityAccountsClient identities,
            CancellationToken cancellationToken) =>
        {
            var account = Caller(http);
            return Results.Ok(new MeDto(new(account.Id, account.DisplayName, account.AvatarUrl), account.Roles,
                AiTlt.Identity.ApplicationPermissions.Allows(account.Permissions, "accounts:manage"), true, options.LegacySiteUrl, options.AccountsUrl.TrimEnd('/'),
                ToolsEndpoints.HasAnyPermission(account, options.GeneratePermissions), ToolsEndpoints.HasAnyPermission(account, options.OperatePermissions))
                { Apps = await identities.AppsAsync(account.Id, cancellationToken), Permissions = account.Permissions });
        });

        api.MapGet("/library/{library}/summary", async (string library, HttpContext http, AssetLibraryClient assets, CancellationToken cancellationToken) =>
        {
            if (!Libraries.Contains(library)) return ApiErrors.Result(ApiErrors.NotFound);
            var account = Caller(http);
            var query = http.Request.Query;
            var timeZone = Single(query, "tz") ?? "UTC";
            var summary = library == "mine"
                ? await assets.SummarizeOwnedAsync(account.Id, timeZone, Single(query, "tag"), Single(query, "kind"), cancellationToken)
                : await assets.SummarizeSharedAsync(timeZone, Single(query, "tag"), Single(query, "kind"), cancellationToken);
            return Results.Ok(new SummaryDto(summary.Days.Select(day => new DayDto(day.Day, day.Count)).ToList(), summary.Tags, summary.Total));
        });

        api.MapGet("/library/{library}", async (string library, HttpContext http, AssetLibraryClient assets, AccountDirectory accounts,
            CancellationToken cancellationToken) =>
        {
            if (!Libraries.Contains(library)) return ApiErrors.Result(ApiErrors.NotFound);
            var account = Caller(http);
            var query = Query(http.Request.Query);
            var page = library == "mine"
                ? await assets.ListOwnedAsync(account.Id, query, cancellationToken)
                : await assets.ListSharedAsync(query, cancellationToken);
            IReadOnlyDictionary<Guid, AccountSummary> owners = library == "shared"
                ? await accounts.NamesAsync(page.Items.Select(item => item.OwnerId), cancellationToken)
                : new Dictionary<Guid, AccountSummary>();
            return Results.Ok(new PageDto(page.Items.Select(item => Item(item, account.Id, library == "shared", owners)).ToList(), page.HasMore));
        });
    }

    private static Account Caller(HttpContext http) =>
        ArtistLockersHost.SignedIn(http) ?? throw new InvalidOperationException("The session check did not run.");

    private static ItemDto Item(AssetListItem item, Guid caller, bool withOwner, IReadOnlyDictionary<Guid, AccountSummary> owners)
    {
        var owner = withOwner && owners.TryGetValue(item.OwnerId, out var summary) ? new PersonDto(summary.Id, summary.DisplayName, summary.AvatarUrl) : null;
        return new(item.Id, item.Filename, item.Description, item.ContentType, item.Kind, item.SizeBytes, owner, item.Published, item.Shared,
            item.Kit, item.Tags, item.CreatedAt, item.DurationSeconds, item.Width, item.Height, $"{MediaProxy.Path}{item.Id}",
            item.HasPoster ? $"{MediaProxy.Path}{item.Id}/poster" : null, item.SourceAssetId, item.SourceFrame, item.OwnerId == caller);
    }

    // Mirrors the gallery's own parsing: a repeated parameter is refused rather than one of its values picked.
    internal static AssetListQuery Query(IQueryCollection query) => new(
        Time(query, "from"), Time(query, "to"), Single(query, "tag"), Single(query, "kind"),
        Number(query, "limit") ?? AssetListQuery.DefaultLimit, Number(query, "offset") ?? 0);

    private static string? Single(IQueryCollection query, string name) => query[name].Count switch
    {
        0 => null, 1 => query[name][0], _ => throw new AssetListQueryException($"Repeated {name}.")
    };
    private static DateTimeOffset? Time(IQueryCollection query, string name) => Single(query, name) is not { Length: > 0 } text ? null
        : DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var value) ? value
        : throw new AssetListQueryException($"Invalid {name}.");
    private static int? Number(IQueryCollection query, string name) => Single(query, name) is not { Length: > 0 } text ? null
        : int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value
        : throw new AssetListQueryException($"Invalid {name}.");
}
