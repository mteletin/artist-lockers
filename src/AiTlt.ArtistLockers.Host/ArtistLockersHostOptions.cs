using AiTlt.InternalAccess;

namespace AiTlt.ArtistLockers.Hosting;

public sealed class ArtistLockersHostOptions
{
    /// <summary>Directory for the Data Protection key ring (cookie encryption). Required outside Development.</summary>
    public string? KeysDirectory { get; set; }
    /// <summary>How long a signed-in account read from identity is trusted before it is read again.</summary>
    public int AccountCacheSeconds { get; set; } = 0;
    /// <summary>The legacy site, for what the artistlockers does not do yet (the tools, the Codex).</summary>
    public string LegacySiteUrl { get; set; } = "";
    /// <summary>Identity's public site: members sign in there (<c>/auth/sso</c>) and manage their account.</summary>
    public string AccountsUrl { get; set; } = "https://accounts.ai-tlt.eu";
    /// <summary>The artistlockers's own public address; its sign-in callback is <c>{PublicUrl}/auth/sso/callback</c>, registered with
    /// identity.</summary>
    public string PublicUrl { get; set; } = "https://artistlockers.eu";
    /// <summary>How long an upload may take end to end: the browser's file is streamed through to the gallery as it arrives.</summary>
    public int UploadTimeoutSeconds { get; set; } = 900;
    /// <summary>Uploads, edits, shares, deletes and frame saves per member per hour, as Mobvision limited its asset writes.</summary>
    public int WritesPerHour { get; set; } = 20;
    /// <summary>Members holding one of these roles skip the write limit: Mobvision's staff (the Lore and Production teams, the admins).</summary>
    public string[] WriteLimitExemptPermissions { get; set; } = ["artistlockers:manage"];
    /// <summary>Accounts that skip the write limit by id, as Mobvision's RateLimits:ExemptUserIds.</summary>
    public Guid[] WriteLimitExemptAccountIds { get; set; } = [];
    /// <summary>Members holding one of these roles get Video Generation, the Image Generator and the AI zone, as Mobvision's tools
    /// gate did.</summary>
    public string[] GeneratePermissions { get; set; } = ["studio:access"];
    /// <summary>Members holding one of these roles run the tools: workers, models, settings, the job audit and the GPU board.</summary>
    public string[] OperatePermissions { get; set; } = ["studio:manage"];
    /// <summary>The tools' deadline for calls that wait on the prompt specialist or probe every worker; the rest use
    /// Tools:TimeoutSeconds.</summary>
    public int ToolsSlowTimeoutSeconds { get; set; } = 200;
}

/// <summary>An AI-TLT service the artistlockers calls on the private network with its own platform-signed tokens.</summary>
public sealed class ServiceOptions
{
    public string BaseUrl { get; set; } = "";
    /// <summary>SHA-256 of the service's self-signed certificate (hex). Empty: the system trust store decides.</summary>
    public string CertificateSha256 { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 30;
    /// <summary>The artistlockers's key for this service; the audience names the service.</summary>
    public InternalTokenIssuerOptions Signing { get; set; } = new();
}
