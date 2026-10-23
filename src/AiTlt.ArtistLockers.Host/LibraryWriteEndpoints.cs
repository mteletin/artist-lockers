using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiTlt.Assets;
using AiTlt.Assets.Http;
using AiTlt.Identity;
using AiTlt.Jobs;
using AiTlt.Jobs.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Net.Http.Headers;

namespace AiTlt.ArtistLockers.Hosting;

public sealed record UploadMetaDto(string? Filename, string? Description, IReadOnlyList<string>? Tags);
public sealed record EditDto(string? Filename, string? Description, IReadOnlyList<string>? Tags);
public sealed record UseDto(string Area, string Item, string Field);
public sealed record InUseDto(string Code, string Message, IReadOnlyList<UseDto> Usages);
public sealed record FrameInfoDto(int FrameCount, double Fps, double DurationSeconds, int Width, int Height, int LastFrame);
/// <summary>The video's name comes from the page that shows it: it only names the member's own private frame.</summary>
public sealed record FrameSaveDto(int Frame, string? VideoFilename);
public sealed record FrameSavedDto(ItemDto Item, bool Created);

/// <summary>
/// /api/v1/library/mine writes: the member's own uploads, edits, sharing, deletes and frame grabs, through the gallery with an
/// actor token for assets:write:self. Edit, share and delete reach only the member's private media; once shared, moderation
/// owns the record. Every write counts towards the member's hourly limit, as Mobvision's asset writes did.
/// </summary>
public static class LibraryWriteEndpoints
{
    public const string FrameTag = "video-frame";
    public const string LastFrameTag = "last-frame";
    public const int PromptExcerptMax = 150;
    private const int MetaLimit = 16 * 1024;
    private static readonly TimeSpan FrameInfoLifetime = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private sealed record FrameInfoKey(Guid Account, Guid Asset);

    public static void Map(WebApplication app)
    {
        var mine = app.MapGroup("/api/v1/library/mine").RequireAuthorization(ArtistLockersHost.BrowserPolicy);

        mine.MapPost("", UploadAsync).RequireRateLimiting(ArtistLockersHost.WritePolicy);

        mine.MapPut("/{assetId:guid}", async (Guid assetId, EditDto edit, HttpContext http, AssetWriteClient assets, CancellationToken cancellationToken) =>
        {
            var account = Caller(http);
            return await assets.EditOwnedAsync(assetId, account.Id, new AssetEdit(edit.Filename, edit.Description, edit.Tags), cancellationToken) is { } record
                ? Results.Ok(Item(record, account.Id)) : ApiErrors.Result(ApiErrors.NotFound);
        }).RequireRateLimiting(ArtistLockersHost.WritePolicy);

        // Sharing asks for moderation: the record joins the site pool unapproved and is published only once an admin approves it.
        mine.MapPost("/{assetId:guid}/share", async (Guid assetId, HttpContext http, AssetWriteClient assets, CancellationToken cancellationToken) =>
        {
            var account = Caller(http);
            return await assets.ShareOwnedAsync(assetId, account.Id, cancellationToken) is { } record
                ? Results.Ok(Item(record, account.Id)) : ApiErrors.Result(ApiErrors.NotFound);
        }).RequireRateLimiting(ArtistLockersHost.WritePolicy);

        mine.MapDelete("/{assetId:guid}", async (Guid assetId, HttpContext http, AssetWriteClient assets, CancellationToken cancellationToken) =>
        {
            var outcome = await assets.DeleteOwnedAsync(assetId, Caller(http).Id, cancellationToken);
            if (!outcome.Found) return ApiErrors.Result(ApiErrors.NotFound);
            if (outcome.Deleted) return Results.NoContent();
            var uses = outcome.Usages.Select(use => new UseDto(use.Area, use.Item, use.Field)).ToList();
            return Results.Json(new InUseDto(ApiErrors.AssetInUse, "This media is still used elsewhere; remove it there first.", uses),
                statusCode: StatusCodes.Status409Conflict);
        }).RequireRateLimiting(ArtistLockersHost.WritePolicy);

        mine.MapGet("/{assetId:guid}/frames", async (Guid assetId, HttpContext http, AssetWriteClient assets, IMemoryCache cache,
            CancellationToken cancellationToken) => await FrameInfoAsync(assetId, Caller(http).Id, assets, cache, cancellationToken) is { } info
                ? Results.Ok(new FrameInfoDto(info.FrameCount, info.Fps, info.DurationSeconds, info.Width, info.Height, info.FrameCount - 1))
                : ApiErrors.Result(ApiErrors.NotFound));

        mine.MapPost("/{assetId:guid}/frames", SaveFrameAsync).RequireRateLimiting(ArtistLockersHost.WritePolicy);
    }

    /// <summary>
    /// A multipart body: a "meta" part (JSON: filename, description, tags), then the "file" part, streamed through to the gallery
    /// as it arrives. The type is checked from the first bytes and the size counted against the kind's limit here as well, so a
    /// refusal is an answer and not a reset connection. Kind and content type always come from the bytes.
    /// </summary>
    private static async Task<IResult> UploadAsync(HttpContext http, ArtistLockersUploads uploads, CancellationToken cancellationToken)
    {
        var account = Caller(http);
        var request = http.Request;
        var bodyLimit = AssetWriteRules.MaxUploadBodyBytes + MetaLimit;
        if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit) limit.MaxRequestBodySize = bodyLimit;
        if (request.ContentLength > bodyLimit) return ApiErrors.Result(ApiErrors.UploadTooLarge);
        if (!MediaTypeHeaderValue.TryParse(request.ContentType, out var type)
            || !string.Equals(type.MediaType.Value, "multipart/form-data", StringComparison.OrdinalIgnoreCase)
            || HeaderUtilities.RemoveQuotes(type.Boundary).Value is not { Length: > 0 and <= 70 } boundary)
            return ApiErrors.Result(ApiErrors.WriteInvalid, "Send the upload as multipart/form-data: a meta part, then the file.");

        var reader = new MultipartReader(boundary, request.Body) { HeadersLengthLimit = MetaLimit, BodyLengthLimit = bodyLimit };
        UploadMetaDto? meta = null;
        try
        {
            for (var section = await reader.ReadNextSectionAsync(cancellationToken); section is not null; section = await reader.ReadNextSectionAsync(cancellationToken))
            {
                if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition)) break;
                var name = HeaderUtilities.RemoveQuotes(disposition.Name).Value;
                if (name == "meta" && meta is null)
                {
                    meta = await ReadMetaAsync(section.Body, cancellationToken);
                    if (meta is null) return ApiErrors.Result(ApiErrors.WriteInvalid, "The upload's meta part is not valid.");
                    continue;
                }
                if (name != "file" || meta is null) break;

                var filename = meta.Filename is { Length: > 0 } given ? given
                    : HeaderUtilities.RemoveQuotes(disposition.FileNameStar.HasValue ? disposition.FileNameStar : disposition.FileName).Value;
                var upload = new AssetUploadMeta(AssetWriteRules.Filename(filename), meta.Description, meta.Tags);
                var header = await HeaderAsync(section.Body, cancellationToken);
                if (AssetWriteRules.Sniff(header) is not { } sniffed) return ApiErrors.Result(ApiErrors.UploadUnsupported);
                await using var content = new CappedStream(header, section.Body, AssetWriteRules.MaxBytes(sniffed.Kind));
                try
                {
                    var record = await uploads.Client.UploadAsync(account.Id, upload, content, cancellationToken);
                    return Results.Json(Item(record, account.Id), statusCode: StatusCodes.Status201Created);
                }
                catch (AssetWriteException) when (content.Exceeded) { return ApiErrors.Result(ApiErrors.UploadTooLarge); }
            }
        }
        catch (InvalidDataException) { return ApiErrors.Result(ApiErrors.WriteInvalid, "The upload is not valid multipart/form-data."); }
        return ApiErrors.Result(ApiErrors.WriteInvalid, "Send a meta part, then the file part.");
    }

    /// <summary>
    /// Mobvision's frame tool: the exact frame as a private PNG named <c>frame-&lt;video&gt;-f&lt;N&gt;.png</c>, tagged video-frame
    /// (and last-frame for the last one), described with the frame, the video, its generation date and prompt where the tools have
    /// that job. Saving the same frame again returns the first save.
    /// </summary>
    private static async Task<IResult> SaveFrameAsync(Guid assetId, FrameSaveDto body, HttpContext http, AssetWriteClient assets, GenerationClient jobs,
        IMemoryCache cache, ILoggerFactory logs, CancellationToken cancellationToken)
    {
        var account = Caller(http);
        if (await FrameInfoAsync(assetId, account.Id, assets, cache, cancellationToken) is not { } info) return ApiErrors.Result(ApiErrors.NotFound);
        var lastFrame = info.FrameCount - 1;
        if (body.Frame < 0 || body.Frame > lastFrame)
            return ApiErrors.Result(ApiErrors.FrameOutOfRange, $"Frame must be between 0 and {lastFrame}.");

        // The prompt only enriches the description: the tools being down costs the excerpt, not the frame.
        GenerationDetail? generation = null;
        try { generation = await jobs.GetOwnedByResultAsync(account.Id, assetId, cancellationToken); }
        catch (GenerationServiceException exception) { logs.CreateLogger("ArtistLockers.Frames").LogWarning(exception, "The tools could not name the video's job."); }

        var video = string.IsNullOrWhiteSpace(body.VideoFilename) ? "video" : AssetWriteRules.Filename(body.VideoFilename);
        var isLast = body.Frame == lastFrame;
        var request = new AssetFrameRequest(body.Frame, FrameFilename(video, body.Frame),
            DescribeFrame(video, body.Frame, lastFrame, generation?.Job.CreatedAt, generation?.Job.Prompt),
            isLast ? [FrameTag, LastFrameTag] : [FrameTag]);
        if (await assets.SaveFrameAsync(assetId, account.Id, request, cancellationToken) is not { } saved) return ApiErrors.Result(ApiErrors.NotFound);
        return Results.Json(new FrameSavedDto(Item(saved.Asset, account.Id), saved.Created),
            statusCode: saved.Created ? StatusCodes.Status201Created : StatusCodes.Status200OK);
    }

    /// <summary>Counting a video's frames stages it from storage, so the answer is kept for the save that follows.</summary>
    private static async Task<AssetFrameInfo?> FrameInfoAsync(Guid assetId, Guid account, AssetWriteClient assets, IMemoryCache cache, CancellationToken cancellationToken)
    {
        var key = new FrameInfoKey(account, assetId);
        if (cache.TryGetValue(key, out AssetFrameInfo? cached) && cached is not null) return cached;
        var info = await assets.FrameInfoAsync(assetId, account, cancellationToken);
        if (info is not null) cache.Set(key, info, FrameInfoLifetime);
        return info;
    }

    /// <summary><c>frame-&lt;video name without extension&gt;-f123.png</c>, as Mobvision names them; Extend finds continuation frames by
    /// the prefix.</summary>
    public static string FrameFilename(string videoFilename, int frame)
    {
        var stem = Path.GetFileNameWithoutExtension(videoFilename ?? "");
        if (string.IsNullOrWhiteSpace(stem)) stem = "video";
        return $"frame-{stem}-f{frame}.png";
    }

    /// <summary>"Frame 123/123 (last) of h3-xxxx.mp4, generated 27 Sep 2026. Prompt: …", as Mobvision describes them.</summary>
    public static string DescribeFrame(string videoFilename, int frame, int lastFrame, DateTimeOffset? generatedAt, string? prompt)
    {
        var text = $"Frame {frame}/{lastFrame}{(frame == lastFrame ? " (last)" : "")} of {videoFilename}";
        if (generatedAt is { } at) text += ", generated " + at.UtcDateTime.ToString("d MMM yyyy", CultureInfo.InvariantCulture);
        text += ".";
        var flat = Regex.Replace(prompt ?? "", @"\s+", " ").Trim();
        if (flat.Length > 0) text += " Prompt: " + CutAtBoundary(flat, PromptExcerptMax);
        return text;
    }

    // Mobvision's H3PromptAdvisor.CutAtBoundary: the last line break or space past the halfway mark, else a hard cut.
    private static string CutAtBoundary(string text, int max)
    {
        if (text.Length <= max) return text;
        var cut = text.LastIndexOf('\n', max - 1);
        if (cut < max / 2) cut = text.LastIndexOf(' ', max - 1);
        if (cut < max / 2) cut = max;
        return text[..cut].TrimEnd();
    }

    private static async Task<UploadMetaDto?> ReadMetaAsync(Stream body, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[4096];
        int count;
        while ((count = await body.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + count > MetaLimit) return null;
            buffer.Write(chunk, 0, count);
        }
        try { return JsonSerializer.Deserialize<UploadMetaDto>(buffer.ToArray(), Json); }
        catch (JsonException) { return null; }
    }

    private static async Task<byte[]> HeaderAsync(Stream body, CancellationToken cancellationToken)
    {
        var header = new byte[AssetWriteRules.HeaderBytes];
        var read = 0;
        int count;
        while (read < header.Length && (count = await body.ReadAsync(header.AsMemory(read), cancellationToken)) > 0) read += count;
        return header[..read];
    }

    private static Account Caller(HttpContext http) =>
        ArtistLockersHost.SignedIn(http) ?? throw new InvalidOperationException("The session check did not run.");

    /// <summary>A gallery record as the library lists it: published is approved and shared.</summary>
    internal static ItemDto Item(AssetRecord record, Guid caller) => new(record.Id, record.Filename, record.Description, record.ContentType,
        record.Kind, record.SizeBytes, null, record.Approved && record.Scope == AssetScopes.Site, record.Scope == AssetScopes.Site, record.Kit,
        record.Tags, record.CreatedAt, record.DurationSeconds, record.Width, record.Height, $"{MediaProxy.Path}{record.Id}",
        record.HasPoster ? $"{MediaProxy.Path}{record.Id}/poster" : null, record.SourceAssetId, record.SourceFrame, record.OwnerId == caller);

    /// <summary>The bytes already read for the type check, then the rest of the part; stops, and says so, past the kind's limit.</summary>
    private sealed class CappedStream(byte[] header, Stream rest, long limit) : Stream
    {
        private int _headerRead;
        private long _total;
        public bool Exceeded { get; private set; }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            int count;
            if (_headerRead < header.Length)
            {
                count = Math.Min(buffer.Length, header.Length - _headerRead);
                header.AsMemory(_headerRead, count).CopyTo(buffer);
                _headerRead += count;
            }
            else count = await rest.ReadAsync(buffer, cancellationToken);
            _total += count;
            if (_total > limit)
            {
                Exceeded = true;
                throw new IOException("The upload is larger than its kind allows.");
            }
            return count;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => _total; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
