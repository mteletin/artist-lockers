using System.Text.Encodings.Web;
using System.Text.Json;
using AiTlt.Identity;
using AiTlt.Jobs;
using AiTlt.Jobs.Http;

namespace AiTlt.ArtistLockers.Hosting;

public sealed record GenerationRefDto(string Rail, int Slot, Guid AssetId, bool WithAudio, string? Filename, string Url);
/// <summary>Seeds go out as text: most are past what a browser's numbers hold exactly.</summary>
public sealed record GenerationDto(Guid Id, string Status, string Model, string ModelLabel, string Kind, string? Mode, string Flow,
    string? RunFlow, string Prompt, string? NegativePrompt, string? Idea, int Width, int Height, int LengthFrames, double Seconds,
    int Steps, string Seed, double? Cfg, string Sampler, string Scheduler, string RefImageSize, int? RefResolution,
    IReadOnlyList<GenerationRefDto> Refs, string? LastError, int AttemptCount, Guid? ResultAssetId, string? ResultUrl,
    DateTimeOffset CreatedAt, DateTimeOffset? QueuedAt, DateTimeOffset? StartedAt, DateTimeOffset? CompletedAt);
/// <summary>The workflow is indented text for the same reason: parsed in a browser its seeds would be rounded.</summary>
public sealed record GenerationDetailDto(GenerationDto Job, string? Workflow, JsonElement? Continuation);
public sealed record GenerationPageDto(IReadOnlyList<GenerationDto> Items, bool HasMore);

/// <summary>/api/v1/generations: the member's own generation history (the tools' job mirror), read-only. Submitting, repeating
/// and cancelling stay on the legacy site until the tools own the queue.</summary>
public static class GenerationEndpoints
{
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api/v1").RequireAuthorization(ArtistLockersHost.BrowserPolicy);

        api.MapGet("/generations", async (HttpContext http, GenerationClient jobs, CancellationToken cancellationToken) =>
        {
            var page = await jobs.ListOwnedAsync(Caller(http).Id, Query(http.Request.Query), cancellationToken);
            return Results.Ok(new GenerationPageDto(page.Items.Select(Job).ToList(), page.HasMore));
        });

        api.MapGet("/generations/{jobId:guid}", async (Guid jobId, HttpContext http, GenerationClient jobs, CancellationToken cancellationToken)
            => Detail(await jobs.GetOwnedAsync(Caller(http).Id, jobId, cancellationToken)));

        // The gallery viewer asks this for the member's own items; another owner's asset answers like one with no job.
        api.MapGet("/library/mine/{assetId:guid}/generation", async (Guid assetId, HttpContext http, GenerationClient jobs,
            CancellationToken cancellationToken) => Detail(await jobs.GetOwnedByResultAsync(Caller(http).Id, assetId, cancellationToken)));
    }

    private static Account Caller(HttpContext http) =>
        ArtistLockersHost.SignedIn(http) ?? throw new InvalidOperationException("The session check did not run.");

    private static IResult Detail(GenerationDetail? detail) => detail is null ? ApiErrors.Result(ApiErrors.NotFound)
        : Results.Ok(new GenerationDetailDto(Job(detail.Job),
            detail.Workflow is { } workflow ? JsonSerializer.Serialize(workflow, Indented) : null, detail.Continuation));

    internal static GenerationDto Job(GenerationJob job) => new(job.Id, job.Status, job.Model, job.ModelLabel, job.Kind, job.Mode, job.Flow,
        job.RunFlow, job.Prompt, job.NegativePrompt, job.Idea, job.Width, job.Height, job.LengthFrames, job.Seconds, job.Steps,
        job.Seed.ToString(System.Globalization.CultureInfo.InvariantCulture), job.Cfg, job.Sampler, job.Scheduler, job.RefImageSize,
        job.RefResolution, job.Refs.Select(reference => new GenerationRefDto(reference.Rail, reference.Slot, reference.AssetId,
            reference.WithAudio, reference.Filename, $"{MediaProxy.Path}{reference.AssetId}")).ToList(),
        job.LastError, job.AttemptCount, job.ResultAssetId, job.ResultAssetId is { } result ? $"{MediaProxy.Path}{result}" : null,
        job.CreatedAt, job.QueuedAt, job.StartedAt, job.CompletedAt);

    // Mirrors the tools' parsing: a repeated parameter is refused rather than one of its values picked.
    internal static GenerationQuery Query(IQueryCollection query) => new(Single(query, "status"), Single(query, "kind"),
        Number(query, "limit") ?? GenerationQuery.DefaultLimit, Number(query, "offset") ?? 0);

    private static string? Single(IQueryCollection query, string name) => query[name].Count switch
    {
        0 => null, 1 => query[name][0], _ => throw new GenerationQueryException($"Repeated {name}.")
    };
    private static int? Number(IQueryCollection query, string name) => Single(query, name) is not { Length: > 0 } text ? null
        : int.TryParse(text, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var value) ? value
        : throw new GenerationQueryException($"Invalid {name}.");
}
