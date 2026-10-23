using AiTlt.Assets;
using AiTlt.Assets.Http;
using AiTlt.Identity.Http;
using AiTlt.Jobs;
using AiTlt.Jobs.Http;

namespace AiTlt.ArtistLockers.Hosting;

public sealed record ErrorDto(string Code, string Message);

/// <summary>Turns failures into <c>{code, message}</c> responses for /api and /auth.</summary>
public static class ApiErrors
{
    public const string InvalidQuery = "artistlockers_invalid_query";
    public const string NotFound = "artistlockers_not_found";
    public const string CsrfRejected = "artistlockers_request_rejected";
    public const string IdentityUnavailable = "artistlockers_identity_unavailable";
    public const string LibraryUnavailable = "artistlockers_library_unavailable";
    public const string LibraryTimeout = "artistlockers_library_timeout";
    public const string JobsUnavailable = "artistlockers_jobs_unavailable";
    public const string JobsTimeout = "artistlockers_jobs_timeout";
    public const string WriteInvalid = "artistlockers_write_invalid";
    public const string UploadTooLarge = "artistlockers_upload_too_large";
    public const string UploadUnsupported = "artistlockers_upload_unsupported";
    public const string AssetInUse = "artistlockers_asset_in_use";
    public const string DeleteUnavailable = "artistlockers_delete_unavailable";
    public const string FrameOutOfRange = "artistlockers_frame_out_of_range";
    public const string FrameUnreadable = "artistlockers_frame_unreadable";
    public const string WriteLimited = "artistlockers_write_limited";
    public const string ToolsForbidden = "artistlockers_tools_forbidden";
    public const string ToolsInvalid = "artistlockers_tools_invalid";
    public const string ToolsRefused = "artistlockers_tools_refused";
    public const string ToolsUnavailable = "artistlockers_tools_unavailable";
    public const string ToolsTimeout = "artistlockers_tools_timeout";
    public const string BoardForbidden = "artistlockers_board_forbidden";
    public const string BoardRefused = "artistlockers_board_refused";
    public const string BoardConflict = "artistlockers_board_conflict";
    public const string BoardTooLarge = "artistlockers_board_too_large";
    public const string BoardUnavailable = "artistlockers_board_unavailable";
    public const string BoardTimeout = "artistlockers_board_timeout";
    public const string BoardMisconfigured = "artistlockers_board_misconfigured";
    public const string CodexForbidden = "artistlockers_codex_forbidden";
    public const string CodexRefused = "artistlockers_codex_refused";
    public const string CodexConflict = "artistlockers_codex_conflict";
    public const string CodexStale = "artistlockers_codex_stale";
    public const string CodexTooLarge = "artistlockers_codex_too_large";
    public const string CodexUnprocessable = "artistlockers_codex_unprocessable";
    public const string CodexUnavailable = "artistlockers_codex_unavailable";
    public const string CodexTimeout = "artistlockers_codex_timeout";
    public const string CodexMisconfigured = "artistlockers_codex_misconfigured";

    private static readonly Dictionary<string, (int Status, string Message)> Known = new(StringComparer.Ordinal)
    {
        [InvalidQuery] = (400, "That filter is not valid."),
        [NotFound] = (404, "That doesn't exist here."),
        [CsrfRejected] = (403, "The request was rejected. Reload the page and try again."),
        [IdentityUnavailable] = (503, "The account service is temporarily unavailable."),
        [LibraryUnavailable] = (503, "The media library is temporarily unavailable."),
        [LibraryTimeout] = (504, "The media library took too long to answer."),
        [JobsUnavailable] = (503, "The generation history is temporarily unavailable."),
        [JobsTimeout] = (504, "The generation history took too long to answer."),
        [WriteInvalid] = (400, "That change is not valid."),
        [UploadTooLarge] = (413, "That file is too large: images up to 25 MB, audio up to 64 MB, video up to 256 MB."),
        [UploadUnsupported] = (415, "That file type is not supported: PNG, JPEG, WebP or GIF images; WAV, FLAC, Ogg, MP3 or M4A audio; MP4 or WebM video."),
        [AssetInUse] = (409, "This media is still used elsewhere; remove it there first."),
        [DeleteUnavailable] = (503, "Deleting is paused while the site checks where media is used. Try again in a few minutes."),
        [FrameOutOfRange] = (400, "That frame is not in the video."),
        [FrameUnreadable] = (422, "This video's frames could not be read."),
        [WriteLimited] = (429, "Too many changes in the last hour. Please wait and try again."),
        [ToolsForbidden] = (403, "Your account does not have access to this tool."),
        [ToolsInvalid] = (400, "That request is not valid."),
        // ToolsRefused carries the tools' own message and status (ToolsProxy); this one is only the fallback.
        [ToolsRefused] = (400, "The tools refused that request."),
        [ToolsUnavailable] = (503, "The generation tools are temporarily unavailable."),
        [ToolsTimeout] = (504, "The generation tools took too long to answer."),
        // The board decides who is on the team; the artistlockers only passes its answer on.
        [BoardForbidden] = (403, "You are not on the team."),
        // BoardRefused, BoardConflict, BoardUnavailable and BoardTimeout carry the board's own message when it sends one.
        [BoardRefused] = (400, "The team board refused that change."),
        [BoardConflict] = (409, "This item changed. Reload it and try again."),
        [BoardTooLarge] = (413, "That file is too large: files up to 20 MB."),
        [BoardUnavailable] = (503, "The team board is temporarily unavailable."),
        [BoardTimeout] = (504, "The team board took too long to answer."),
        [BoardMisconfigured] = (502, "The artistlockers could not sign in to the team board."),
        // The Codex decides who may open, edit and share a page; every Codex code but the last carries its words when it sends some.
        [CodexForbidden] = (403, "Your account cannot open the Codex."),
        [CodexRefused] = (400, "The Codex refused that change."),
        [CodexConflict] = (409, "That conflicts with the page as it is now. Reload it and try again."),
        [CodexStale] = (409, "Someone else saved this page after you opened it."),
        [CodexTooLarge] = (413, CodexEndpoints.TooLargeWords),
        [CodexUnprocessable] = (422, "The Codex could not read that."),
        [CodexUnavailable] = (503, "The Codex is temporarily unavailable."),
        [CodexTimeout] = (504, "The Codex took too long to answer."),
        [CodexMisconfigured] = (502, "The artistlockers could not sign in to the Codex."),
    };

    public static IResult Result(string code, string? message = null)
    {
        var (status, known) = Known.TryGetValue(code, out var entry) ? entry : (400, "That request was not valid.");
        return Results.Json(new ErrorDto(code, message ?? known), statusCode: status);
    }

    public static Task WriteAsync(HttpContext http, string code)
    {
        var (status, message) = Known.TryGetValue(code, out var known) ? known : (400, "That request was not valid.");
        http.Response.StatusCode = status;
        return http.Response.WriteAsJsonAsync(new ErrorDto(code, message));
    }

    /// <summary>Middleware for /api and /auth: a refused query is the caller's, an unreachable service a 503 or 504.</summary>
    public static async Task HandleAsync(HttpContext http, RequestDelegate next)
    {
        string code;
        try
        {
            await next(http);
            return;
        }
        catch (AssetListQueryException) { code = InvalidQuery; }
        catch (GenerationQueryException) { code = InvalidQuery; }
        catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status413PayloadTooLarge) { code = UploadTooLarge; }
        catch (BadHttpRequestException) { code = InvalidQuery; }
        catch (AssetWriteValidationException exception)
        {
            // The gallery's refusals are written for people (sizes, tag rules): its message is shown where it has no code of ours.
            code = Written(exception.Code);
            if (code == WriteInvalid)
            {
                if (http.Response.HasStarted) return;
                http.Response.Clear();
                http.Response.StatusCode = 400;
                await http.Response.WriteAsJsonAsync(new ErrorDto(code, exception.Message));
                return;
            }
        }
        catch (AssetWriteException exception)
        {
            Log(http, exception);
            code = exception.Code == AssetWriteCapability.UsesStaleCode ? DeleteUnavailable : exception.IsTimeout ? LibraryTimeout : LibraryUnavailable;
        }
        catch (AssetLibraryException exception)
        {
            Log(http, exception);
            code = exception.IsTimeout ? LibraryTimeout : LibraryUnavailable;
        }
        catch (GenerationServiceException exception)
        {
            Log(http, exception);
            code = exception.IsTimeout ? JobsTimeout : JobsUnavailable;
        }
        catch (ToolsRequestException) { code = ToolsInvalid; }
        catch (ToolsServiceException exception)
        {
            Log(http, exception);
            code = exception.IsTimeout ? ToolsTimeout : ToolsUnavailable;
        }
        catch (CodexServiceException exception)
        {
            Log(http, exception);
            code = exception.IsTimeout ? CodexTimeout : CodexUnavailable;
        }
        catch (IdentityServiceException exception)
        {
            Log(http, exception);
            code = IdentityUnavailable;
        }
        if (http.Response.HasStarted) return;
        http.Response.Clear();
        await WriteAsync(http, code);
    }

    private static string Written(string galleryCode) => galleryCode switch
    {
        AssetWriteCapability.TooLargeCode => UploadTooLarge,
        AssetWriteCapability.UnsupportedCode => UploadUnsupported,
        AssetWriteCapability.FrameRangeCode => FrameOutOfRange,
        AssetWriteCapability.FrameUnreadableCode => FrameUnreadable,
        _ => WriteInvalid
    };

    private static void Log(HttpContext http, Exception exception) =>
        http.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("ArtistLockers").LogWarning(exception, "A artistlockers dependency failed.");
}
