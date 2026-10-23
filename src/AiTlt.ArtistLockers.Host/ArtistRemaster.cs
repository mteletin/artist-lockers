using System.Net.Http.Headers;
using AiTlt.InternalAccess;
using Microsoft.AspNetCore.Http.Features;

namespace AiTlt.ArtistLockers.Hosting;

public sealed class ArtistRemaster(IHttpClientFactory clients,
    [Microsoft.Extensions.DependencyInjection.FromKeyedServices(ArtistLockersServices.Tools)] InternalActorTokenIssuer issuer)
{
    public async Task<IResult> ForwardAsync(HttpContext http,Guid owner,string suffix="")
    {
        if(http.Features.Get<IHttpMaxRequestBodySizeFeature>() is {IsReadOnly:false} limit)limit.MaxRequestBodySize=101L*1024*1024;
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted);deadline.CancelAfter(TimeSpan.FromMinutes(15));
        using var request=new HttpRequestMessage(new HttpMethod(http.Request.Method),"internal/v1/tools/remaster-jobs"+suffix);
        request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",issuer.Issue(owner,"remaster:use"));
        if(http.Request.ContentLength>0||http.Request.Headers.TransferEncoding.Count>0)
        {
            request.Content=new StreamContent(http.Request.Body);
            if(http.Request.ContentType is {} type)request.Content.Headers.ContentType=MediaTypeHeaderValue.Parse(type);
        }
        var client=clients.CreateClient(ArtistLockersServices.Tools);client.Timeout=Timeout.InfiniteTimeSpan;
        var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token);
        http.Response.RegisterForDispose(response);http.Response.StatusCode=(int)response.StatusCode;http.Response.Headers.CacheControl="no-store";
        if(response.Content.Headers.ContentDisposition is {} disposition)http.Response.Headers.ContentDisposition=disposition.ToString();
        if(response.StatusCode==System.Net.HttpStatusCode.NoContent)return Results.NoContent();
        http.Response.ContentType=response.Content.Headers.ContentType?.ToString()??"application/json";
        await response.Content.CopyToAsync(http.Response.Body,http.RequestAborted);
        return Results.Empty;
    }
}
