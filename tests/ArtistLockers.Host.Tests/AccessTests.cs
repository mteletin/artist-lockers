using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AiTlt.ArtistLockers.Hosting;
using AiTlt.Identity;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Xunit;

namespace ArtistLockers.Host.Tests;

public sealed class AccessTests
{
    [Fact]
    public async Task AnonymousRequestsCannotReadCreatorToolsOrProfiles()
    {
        await using var host = await StartAsync();
        foreach (var path in new[] { "/api/v1/me", "/api/v1/profile", "/api/v1/library/mine", "/api/v1/tools/state", "/api/codex/access" })
            Assert.Equal(HttpStatusCode.Unauthorized, (await host.Client.GetAsync(path)).StatusCode);
        Assert.Empty(host.Peer.Calls);
        Assert.Equal(HttpStatusCode.NotFound, (await host.Client.GetAsync("/internal/v1/accounts")).StatusCode);
    }
    [Theory]
    [InlineData("", 401)]
    [InlineData("studio:access,codex:access", 401)]
    [InlineData("artistlockers:access", 200)]
    [InlineData("artistlockers:manage", 200)]
    public async Task ProductEntryComesFromGrantsAndNotLegacyTeamNames(string grants, int status)
    {
        await using var host = await StartAsync(grants); host.SignIn();
        Assert.Equal(status, (int)(await host.Client.GetAsync("/api/v1/me")).StatusCode);
    }
    [Fact]
    public async Task ProductMembershipDoesNotGrantToolsOrCodexAutomatically()
    {
        await using var host = await StartAsync("artistlockers:access"); host.SignIn();
        Assert.Equal(HttpStatusCode.Forbidden, (await host.Client.GetAsync("/api/v1/tools/state")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await host.Client.GetAsync("/api/codex/access")).StatusCode);
        Assert.DoesNotContain(host.Peer.Calls, call => call.Path.Contains("/tools/") || call.Path.Contains("/codex/"));
    }
    [Fact]
    public async Task ComponentRightsComposeWithProductEntryAndCarryTheSignedInActor()
    {
        await using var host = await StartAsync("artistlockers:access,studio:access,codex:access"); host.SignIn();
        Assert.Equal(HttpStatusCode.OK, (await host.Client.GetAsync("/api/v1/tools/limits")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await host.Client.GetAsync("/api/codex/access")).StatusCode);
        foreach (var call in host.Peer.Calls.Where(call => call.Path.Contains("/tools/") || call.Path.Contains("/codex/")))
        { Assert.Equal(host.Peer.Account.Id.ToString(), call.Subject); Assert.Null(call.Cookie); }
    }
    [Fact]
    public async Task ProfileWritesDelegateTheSessionOwnerAndKeepCsrfBoundary()
    {
        await using var host = await StartAsync(); host.SignIn();
        var path = "/api/v1/profile";
        Assert.Equal(HttpStatusCode.Forbidden, (await host.Client.PutAsJsonAsync(path, new { name = new { value = "Name" } })).StatusCode);
        host.Client.DefaultRequestHeaders.Add("X-AiTlt-Request", "1"); host.Client.DefaultRequestHeaders.Add("Origin", "https://untrusted.test");
        Assert.Equal(HttpStatusCode.Forbidden, (await host.Client.PutAsJsonAsync(path, new { name = new { value = "Name" } })).StatusCode);
        host.Client.DefaultRequestHeaders.Remove("Origin");
        Assert.Equal(HttpStatusCode.OK, (await host.Client.PutAsJsonAsync(path, new { accountId = Guid.NewGuid(), name = new { value = "Name" } })).StatusCode);
        var call = Assert.Single(host.Peer.Calls, call => call.Path == "/internal/v1/profiles/me");
        Assert.Equal(host.Peer.Account.Id.ToString(), call.Subject); Assert.Contains("profiles:write:self", call.Scope);
    }
    [Theory]
    [InlineData(true)] [InlineData(false)]
    public async Task DisabledOrRevokedSessionsAreRefused(bool disabled)
    {
        await using var host = await StartAsync(); host.SignIn();
        host.Peer.Account = disabled ? host.Peer.Account with { DisabledAt = DateTimeOffset.UtcNow } : host.Peer.Account with { SessionVersion = 2 };
        Assert.Equal(HttpStatusCode.Unauthorized, (await host.Client.GetAsync("/api/v1/profile")).StatusCode);
        Assert.DoesNotContain(host.Peer.Calls, call => call.Path == "/internal/v1/profiles/me");
    }
    [Fact]
    public async Task AccountsOutageDoesNotFallBackToTheCookie()
    {
        await using var host = await StartAsync(); host.SignIn(); host.Peer.Down = true;
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await host.Client.GetAsync("/api/v1/profile")).StatusCode);
    }
    [Fact]
    public async Task SignInUsesOwnClientAndRejectsExternalReturnUrls()
    {
        await using var host = await StartAsync();
        var response = await host.Client.GetAsync("/auth/signin?returnUrl=https://untrusted.test");
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.StartsWith("https://accounts.ai-tlt.eu/auth/sso?", response.Headers.Location!.ToString());
        Assert.Contains("client_id=ai-tlt-artistlockers", response.Headers.Location.ToString());
        Assert.Contains("artistlockers.eu", Uri.UnescapeDataString(response.Headers.Location.ToString()));
    }
    [Fact]
    public async Task ArchiveReturnsNoContentAndDelegatesOnlyTheSessionOwner()
    {
        await using var host = await StartAsync(); host.SignIn();
        host.Client.DefaultRequestHeaders.Add("X-AiTlt-Request", "1");
        Assert.Equal(HttpStatusCode.NoContent, (await host.Client.DeleteAsync("/api/v1/profile/personas/" + Guid.NewGuid())).StatusCode);
        var call = Assert.Single(host.Peer.Calls, call => call.Path.StartsWith("/internal/v1/me/personas/"));
        Assert.Equal(host.Peer.Account.Id.ToString(), call.Subject); Assert.Equal("personas:write:self", call.Scope);
        Assert.Null(call.Cookie);
    }
    [Theory]
    [InlineData("/codex.html")] [InlineData("/tools.html")]
    public async Task StandalonePagesRequireProductAndComponentRights(string path)
    {
        await using var host = await StartAsync();
        Assert.Equal(HttpStatusCode.Redirect, (await host.Client.GetAsync(path)).StatusCode);
        host.SignIn(); Assert.Equal(HttpStatusCode.Forbidden, (await host.Client.GetAsync(path)).StatusCode);
    }
    private static async Task<Host> StartAsync(string grants = "artistlockers:access")
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development", ContentRootPath = AppContext.BaseDirectory });
        builder.WebHost.UseUrls("http://127.0.0.1:0"); builder.Logging.ClearProviders();
        var peer = new Peer(grants.Split(',', StringSplitOptions.RemoveEmptyEntries));
        using var rsa = RSA.Create(2048); var privateKey = rsa.ExportPkcs8PrivateKeyPem();
        var settings = new Dictionary<string,string?> { ["ArtistLockers:AccountCacheSeconds"] = "0" };
        foreach (var (name,audience) in new[] { ("Identity","identity"), ("Gallery","gallery"), ("Tools","tools"), ("Codex","codex") })
        {
            settings[name+":BaseUrl"]="https://"+name.ToLowerInvariant()+".test/";
            settings[name+":Signing:ClientId"]="ai-tlt-artistlockers";settings[name+":Signing:Issuer"]="urn:ai-tlt:client:artistlockers";
            settings[name+":Signing:Audience"]="urn:ai-tlt:"+audience;settings[name+":Signing:KeyId"]="test";settings[name+":Signing:PrivateKeyPem"]=privateKey;
        }
        builder.Configuration.AddInMemoryCollection(settings); builder.AddArtistLockersHost();
        foreach (var name in new[] { ArtistLockersServices.Identity,ArtistLockersServices.Gallery,ArtistLockersServices.Tools,ArtistLockersServices.Codex })
            builder.Services.AddHttpClient(name).ConfigurePrimaryHttpMessageHandler(()=>peer);
        var app=builder.Build();app.MapArtistLockersHost();await app.StartAsync();
        var address=app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var client=new HttpClient(new HttpClientHandler { AllowAutoRedirect=false,UseCookies=false }) { BaseAddress=new Uri(address) };
        return new(app,client,peer);
    }
    public sealed record Call(string Path,string? Subject,string Scope,string? Cookie);
    public sealed class Peer(string[] permissions):HttpMessageHandler
    {
        public Account Account {get;set;}=new(Guid.NewGuid(),"Creator",null,DateTimeOffset.UtcNow,null,null,1,["admin","tools_access"],[]) { Permissions=permissions };
        public List<Call> Calls {get;}=[];public bool Down {get;set;}
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            if(Down)throw new HttpRequestException("Offline");
            var part=request.Headers.Authorization!.Parameter!.Split('.')[1];part=part.Replace('-','+').Replace('_','/');part=part.PadRight((part.Length+3)/4*4,'=');
            using var claims=JsonDocument.Parse(Convert.FromBase64String(part));var root=claims.RootElement;
            Calls.Add(new(request.RequestUri!.AbsolutePath,root.TryGetProperty("sub",out var sub)?sub.GetString():null,root.GetProperty("scope").GetString()!,request.Headers.TryGetValues("Cookie",out var cookies)?string.Join(';',cookies):null));
            if (request.Method == HttpMethod.Delete && request.RequestUri.AbsolutePath.StartsWith("/internal/v1/me/"))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            object body=request.RequestUri.AbsolutePath.EndsWith("/apps")?Array.Empty<AccountAppLink>():
                request.RequestUri.AbsolutePath.StartsWith("/internal/v1/accounts/")?Account:
                request.RequestUri.AbsolutePath=="/internal/v1/profiles/me"?new { accountId=Account.Id,name="Creator",slug="creator",country="",bio="",themeId="default",imageUrl=(string?)null }:
                request.RequestUri.AbsolutePath.EndsWith("/access")?new { allowed=true,staff=false }:new { models=Array.Empty<object>(),items=Array.Empty<object>() };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content=JsonContent.Create(body) });
        }
    }
    private sealed record Host(WebApplication App,HttpClient Client,Peer Peer):IAsyncDisposable
    {
        public void SignIn()
        {
            var options=App.Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>().Get(ArtistLockersHost.CookieScheme);
            var ticket=new AuthenticationTicket(ArtistLockersHost.SessionPrincipal(Peer.Account),new AuthenticationProperties { ExpiresUtc=DateTimeOffset.UtcNow.AddHours(1) },ArtistLockersHost.CookieScheme);
            Client.DefaultRequestHeaders.Add("Cookie","ai-tlt.artistlockers.session="+options.TicketDataFormat.Protect(ticket));
        }
        public async ValueTask DisposeAsync(){Client.Dispose();await App.DisposeAsync();}
    }
}
