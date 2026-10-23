using System.Text.Json.Nodes;
using AiTlt.Identity;

namespace AiTlt.ArtistLockers.Hosting;

/// <summary>Only known personal-key providers bypass the local GPU grant. Unknown/default models fail closed.</summary>
public static class GenerationAccess
{
    public const string LocalPermission = "studio:generate_local";
    // Cloud model IDs from the Tools-owned GenModels catalog. New providers require an explicit review here.
    private static readonly HashSet<string> PersonalKeyModels =
        ["seedance-2-5", "seedance-2-0", "seedance-2-0-fast", "seedance-2-0-mini"];

    public static bool CanGenerateLocal(Account account) => ApplicationPermissions.Allows(account.Permissions, LocalPermission);

    public static bool CanSubmit(Account account, JsonObject body)
    {
        var fields = body.Where(pair => pair.Key.Equals("model", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (fields.Length > 1) throw new ToolsRequestException();
        var model = fields.Length == 0 || fields[0].Value is null ? null
            : fields[0].Value is JsonValue value && value.TryGetValue<string>(out var text) ? text.Trim().ToLowerInvariant()
            : throw new ToolsRequestException();
        // Canonicalize the property before delegation: our check and the peer's case-insensitive binder must agree.
        foreach (var field in fields) body.Remove(field.Key);
        body["model"] = model;
        return CanGenerateLocal(account) || model is not null && PersonalKeyModels.Contains(model);
    }

    public static JsonNode? Limits(Account account, JsonNode? node)
    {
        if (node is not JsonObject limits) throw new ToolsServiceException();
        var local = CanGenerateLocal(account);
        limits["canGenerateLocal"] = local;
        if (!local)
        {
            limits["image"] = null;
            limits["continuationWorkers"] = 0;
            if (limits["models"] is JsonArray models)
                foreach (var model in models.OfType<JsonObject>())
                    if (model["id"] is not JsonValue id || !id.TryGetValue<string>(out var key) || !PersonalKeyModels.Contains(key))
                        model["enabled"] = false;
        }
        return limits;
    }
}
