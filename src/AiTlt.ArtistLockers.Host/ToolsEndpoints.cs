using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AiTlt.Identity;
using AiTlt.InternalAccess;

namespace AiTlt.ArtistLockers.Hosting;

/// <summary>The tools could not be reached, failed, or took too long; the browser sees a 503 or 504 with a code.</summary>
public sealed class ToolsServiceException(bool timeout = false) : Exception("Tools service unavailable.")
{
    public bool IsTimeout { get; } = timeout;
}

/// <summary>The browser sent a body that is not a JSON object.</summary>
public sealed class ToolsRequestException() : Exception("The request body is not a JSON object.");

/// <summary>A refusal from the tools, written for people (limits, quota, no workers): its message is shown as it is, under the tools'
/// own status.</summary>
public sealed record ToolsErrorDto(string Code, string Message, string? Reason);

/// <summary>
/// Forwards a browser request to the tools (ai-tlt-tools) with the artistlockers's token for that call: an actor token naming the member
/// for their own use, or a service token for the operator's routes. The caller checks the member's roles before either is issued.
/// Answers come back rewritten for a browser: seeds and integers past 2^53 as text, asset links as the artistlockers's /media/{id}.
/// </summary>
public sealed class ToolsProxy(HttpClient http, InternalActorTokenIssuer issuer, TimeSpan timeout, TimeSpan slowTimeout)
{
    public const string UseScope = "tools:use";
    public const string KeysScope = "tools:keys:self";
    public const string OperateScope = "tools:operate";
    private const int BodyLimit = 8 * 1024 * 1024;
    // Past this a browser's numbers are no longer exact.
    private const decimal SafeInteger = 9007199254740991m;

    /// <summary>One call as the member.</summary>
    public Task<IResult> ActorAsync(Guid account, string scope, HttpMethod method, string path, JsonNode? body, bool slow, CancellationToken ct)
        => SendAsync(issuer.Issue(account, scope), method, path, body, slow, ct);

    /// <summary>One operator call; only after the artistlockers confirmed the member may operate.</summary>
    public Task<IResult> ServiceAsync(HttpMethod method, string path, JsonNode? body, bool slow, CancellationToken ct)
        => SendAsync(issuer.Issue(OperateScope), method, path, body, slow, ct);

    private async Task<IResult> SendAsync(string token, HttpMethod method, string path, JsonNode? body, bool slow, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(slow ? slowTimeout : timeout);
        try
        {
            using var request = new HttpRequestMessage(method, path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            var status = (int)response.StatusCode;
            if (response.StatusCode == HttpStatusCode.NoContent) return Results.NoContent();
            var text = await ReadAsync(response, deadline.Token);
            if (response.IsSuccessStatusCode)
                return Results.Text(text.Length == 0 ? "{}" : Rewrite(JsonNode.Parse(text))?.ToJsonString() ?? "null", "application/json", statusCode: status);
            // The tools' role store may refuse the member even when the artistlockers's roles allow them.
            if (response.StatusCode == HttpStatusCode.Forbidden) return ApiErrors.Result(ApiErrors.ToolsForbidden);
            if (status is 400 or 404 or 409 or 503 or 507 && Refusal(text) is { } refusal)
                return Results.Json(new ToolsErrorDto(ApiErrors.ToolsRefused, refusal.Message, refusal.Reason), statusCode: status);
            // A bare 404 is a missing job or worker, or a disabled route: nothing the member can see either way.
            if (response.StatusCode == HttpStatusCode.NotFound) return ApiErrors.Result(ApiErrors.NotFound);
            throw new ToolsServiceException();
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new ToolsServiceException(timeout: true); }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or NotSupportedException) { throw new ToolsServiceException(); }
    }

    private static (string Message, string? Reason)? Refusal(string text)
    {
        if (text.Length == 0) return null;
        try
        {
            return JsonNode.Parse(text) is JsonObject error && error["error"] is JsonValue message && message.TryGetValue<string>(out var words)
                ? (words, error["status"] is JsonValue reason && reason.TryGetValue<string>(out var name) ? name : null) : null;
        }
        catch (JsonException) { return null; }
    }

    private static async Task<string> ReadAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.Content.Headers.ContentLength is > BodyLimit) throw new ToolsServiceException();
        await using var body = await response.Content.ReadAsStreamAsync(ct);
        using var limited = new MemoryStream();
        var buffer = new byte[16384]; int count;
        while ((count = await body.ReadAsync(buffer, ct)) != 0)
        {
            if (limited.Length + count > BodyLimit) throw new ToolsServiceException();
            limited.Write(buffer, 0, count);
        }
        return Encoding.UTF8.GetString(limited.GetBuffer(), 0, (int)limited.Length);
    }

    /// <summary>What a browser can hold exactly: every seed, and any other integer past 2^53, becomes text; a reference's or a
    /// result's link becomes the artistlockers's media path for its asset id (the tools' links point at the legacy site).</summary>
    internal static JsonNode? Rewrite(JsonNode? node, string? name = null)
    {
        switch (node)
        {
            case JsonObject item:
                foreach (var (key, child) in item.ToList())
                    if (Rewrite(child, key) is var rewritten && !ReferenceEquals(rewritten, child)) item[key] = rewritten;
                if (item.ContainsKey("url") && Id(item["assetId"]) is { } asset) item["url"] = MediaProxy.Path + asset;
                if (item.ContainsKey("resultUrl")) item["resultUrl"] = Id(item["resultAssetId"]) is { } result ? MediaProxy.Path + result : null;
                return item;
            case JsonArray list:
                for (var i = 0; i < list.Count; i++)
                    if (Rewrite(list[i]) is var rewritten && !ReferenceEquals(rewritten, list[i])) list[i] = rewritten;
                return list;
            case JsonValue value when value.GetValueKind() == JsonValueKind.Number:
                var number = value.ToJsonString();
                return string.Equals(name, "seed", StringComparison.OrdinalIgnoreCase) || Unsafe(number) ? JsonValue.Create(number) : value;
            default:
                return node;
        }
    }

    private static bool Unsafe(string number) => number.IndexOfAny(['.', 'e', 'E']) < 0
        && decimal.TryParse(number, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var whole) && Math.Abs(whole) > SafeInteger;

    private static Guid? Id(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) && Guid.TryParse(text, out var id) ? id : null;
}

/// <summary>
/// /api/v1/tools: the generation tools, forwarded to ai-tlt-tools. Video Generation, the Image Generator and the AI zone (the
/// member's own provider keys) need one of <see cref="ArtistLockersHostOptions.GeneratePermissions"/>; the operator's routes (workers, models,
/// settings, the job audit, the GPU board) need one of <see cref="ArtistLockersHostOptions.OperatePermissions"/>. Roles are identity's, read
/// with the session; the tools apply their own limits, quota and reference checks on top.
/// </summary>
public static class ToolsEndpoints
{
    private const string Use = "internal/v1/tools/";
    private const string Keys = "internal/v1/tools/keys";
    private const string Operate = "internal/v1/tools/operate/";
    private static readonly string[] AuditFilters = ["page", "pageSize", "search", "status", "model", "from", "to"];
    private static readonly Regex ModelId = new("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", RegexOptions.CultureInvariant);

    public static void Map(WebApplication app)
    {
        var use = app.MapGroup("/api/v1/tools").RequireAuthorization(ArtistLockersHost.BrowserPolicy)
            .AddEndpointFilter((context, next) => Gate(context, next, options => options.GeneratePermissions));
        var operate = app.MapGroup("/api/v1/tools/operate").RequireAuthorization(ArtistLockersHost.BrowserPolicy)
            .AddEndpointFilter((context, next) => Gate(context, next, options => options.OperatePermissions));

        use.MapGet("/limits", (HttpContext http, ToolsProxy tools, CancellationToken ct) => Mine(http, tools, HttpMethod.Get, Use + "limits", ct));
        use.MapGet("/state", (HttpContext http, ToolsProxy tools, CancellationToken ct) => Mine(http, tools, HttpMethod.Get, Use + "state", ct));
        use.MapGet("/jobs", (HttpContext http, ToolsProxy tools, CancellationToken ct) => Mine(http, tools, HttpMethod.Get, Use + "jobs/mine", ct));
        use.MapGet("/jobs/shelf", (HttpContext http, ToolsProxy tools, CancellationToken ct) => Mine(http, tools, HttpMethod.Get, Use + "jobs/shelf", ct));
        use.MapGet("/jobs/{id:guid}", (Guid id, HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            Mine(http, tools, HttpMethod.Get, Use + $"jobs/{id}", ct));
        // The owner's name on the job is the member's display name as identity has it, never one the browser chose.
        use.MapPost("/jobs", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await Mine(http, tools, HttpMethod.Post, Use + "jobs?ownerName=" + Uri.EscapeDataString(Caller(http).DisplayName), ct,
                Seeded(await BodyAsync(http, ct))));
        use.MapDelete("/jobs/{id:guid}", (Guid id, HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            Mine(http, tools, HttpMethod.Delete, Use + $"jobs/{id}", ct));
        use.MapPost("/jobs/reorder", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await Mine(http, tools, HttpMethod.Post, Use + "jobs/reorder", ct, await BodyAsync(http, ct)));
        use.MapPost("/seen", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await Mine(http, tools, HttpMethod.Post, Use + "seen", ct, await BodyAsync(http, ct)));
        use.MapGet("/generation/{assetId:guid}", (Guid assetId, HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            Mine(http, tools, HttpMethod.Get, Use + $"generation/{assetId}", ct));
        // These three wait on the prompt specialist (or read every reference from the gallery): the slow deadline.
        use.MapPost("/refs/describe", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await Mine(http, tools, HttpMethod.Post, Use + "refs/describe", ct, await BodyAsync(http, ct), slow: true));
        use.MapPost("/prompt/advise", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await Mine(http, tools, HttpMethod.Post, Use + "prompt/advise", ct, Seeded(await BodyAsync(http, ct)), slow: true));
        use.MapPost("/prompt/summarize", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await Mine(http, tools, HttpMethod.Post, Use + "prompt/summarize", ct, await BodyAsync(http, ct), slow: true));

        // The AI zone: the member's own keys for the cloud models.
        use.MapGet("/keys", (HttpContext http, ToolsProxy tools, CancellationToken ct) => Own(http, tools, HttpMethod.Get, Keys, ct));
        use.MapPost("/keys", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await Own(http, tools, HttpMethod.Post, Keys, ct, await BodyAsync(http, ct)));
        use.MapPatch("/keys/{id:guid}", async (Guid id, HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await Own(http, tools, HttpMethod.Patch, Keys + $"/{id}", ct, await BodyAsync(http, ct)));
        use.MapDelete("/keys/{id:guid}", (Guid id, HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            Own(http, tools, HttpMethod.Delete, Keys + $"/{id}", ct));

        operate.MapGet("/settings", (ToolsProxy tools, CancellationToken ct) => tools.ServiceAsync(HttpMethod.Get, Operate + "settings", null, false, ct));
        operate.MapPut("/settings", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await tools.ServiceAsync(HttpMethod.Put, Operate + "settings", await BodyAsync(http, ct), false, ct));
        operate.MapPut("/models/{id}", async (string id, HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            !ModelId.IsMatch(id) ? ApiErrors.Result(ApiErrors.NotFound)
                : await tools.ServiceAsync(HttpMethod.Put, Operate + "models/" + Uri.EscapeDataString(id), await BodyAsync(http, ct), false, ct));
        operate.MapPost("/workers", async (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await tools.ServiceAsync(HttpMethod.Post, Operate + "workers", await BodyAsync(http, ct), false, ct));
        operate.MapPut("/workers/{id:guid}", async (Guid id, HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            await tools.ServiceAsync(HttpMethod.Put, Operate + $"workers/{id}", await BodyAsync(http, ct), false, ct));
        operate.MapDelete("/workers/{id:guid}", (Guid id, ToolsProxy tools, CancellationToken ct) =>
            tools.ServiceAsync(HttpMethod.Delete, Operate + $"workers/{id}", null, false, ct));
        // Each worker is asked in turn, each with its own short deadline on the tools' side.
        operate.MapPost("/workers/probe", (ToolsProxy tools, CancellationToken ct) =>
            tools.ServiceAsync(HttpMethod.Post, Operate + "workers/probe", null, true, ct));
        operate.MapGet("/audit", (HttpContext http, ToolsProxy tools, CancellationToken ct) =>
            tools.ServiceAsync(HttpMethod.Get, Operate + "audit" + AuditQuery(http.Request.Query), null, false, ct));
        operate.MapGet("/audit/{id:guid}", (Guid id, ToolsProxy tools, CancellationToken ct) =>
            tools.ServiceAsync(HttpMethod.Get, Operate + $"audit/{id}", null, false, ct));
        operate.MapGet("/gpus", (ToolsProxy tools, CancellationToken ct) => tools.ServiceAsync(HttpMethod.Get, Operate + "gpus", null, false, ct));
    }

    /// <summary>Whether the member holds one of the roles a group needs; the token for the tools is only issued after this.</summary>
    public static bool HasAnyPermission(Account account, IEnumerable<string> roles) => roles.Any(permission => AiTlt.Identity.ApplicationPermissions.Allows(account.Permissions, permission));

    private static async ValueTask<object?> Gate(EndpointFilterInvocationContext context, EndpointFilterDelegate next, Func<ArtistLockersHostOptions, string[]> roles)
    {
        var http = context.HttpContext;
        return HasAnyPermission(Caller(http), roles(http.RequestServices.GetRequiredService<ArtistLockersHostOptions>()))
            ? await next(context) : ApiErrors.Result(ApiErrors.ToolsForbidden);
    }

    private static Task<IResult> Mine(HttpContext http, ToolsProxy tools, HttpMethod method, string path, CancellationToken ct,
        JsonNode? body = null, bool slow = false) => tools.ActorAsync(Caller(http).Id, ToolsProxy.UseScope, method, path, body, slow, ct);

    private static Task<IResult> Own(HttpContext http, ToolsProxy tools, HttpMethod method, string path, CancellationToken ct, JsonNode? body = null)
        => tools.ActorAsync(Caller(http).Id, ToolsProxy.KeysScope, method, path, body, false, ct);

    private static Account Caller(HttpContext http) =>
        ArtistLockersHost.SignedIn(http) ?? throw new InvalidOperationException("The session check did not run.");

    private static async Task<JsonObject> BodyAsync(HttpContext http, CancellationToken ct)
    {
        try
        {
            return await JsonNode.ParseAsync(http.Request.Body, cancellationToken: ct) as JsonObject ?? throw new ToolsRequestException();
        }
        catch (JsonException) { throw new ToolsRequestException(); }
    }

    // The page holds seeds as text (see ToolsProxy.Rewrite); the tools read a number. Blank is "pick one".
    private static JsonObject Seeded(JsonObject body)
    {
        if (body["seed"] is JsonValue seed && seed.GetValueKind() == JsonValueKind.String)
        {
            var text = seed.GetValue<string>().Trim();
            body["seed"] = text.Length == 0 ? null
                : long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number) ? JsonValue.Create(number)
                : throw new ToolsRequestException();
        }
        return body;
    }

    // Only the audit's own filters go through, each once; the tools validate their values.
    private static string AuditQuery(IQueryCollection query)
    {
        var parts = new List<string>();
        foreach (var name in AuditFilters)
        {
            if (query[name].Count > 1) throw new ToolsRequestException();
            if (query[name] is [{ Length: > 0 } value]) parts.Add(name + "=" + Uri.EscapeDataString(value));
        }
        return parts.Count == 0 ? "" : "?" + string.Join('&', parts);
    }
}
