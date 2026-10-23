using AiTlt.ArtistLockers.Hosting;

var builder = WebApplication.CreateBuilder(args);
builder.AddArtistLockersHost();
var app = builder.Build();
app.MapArtistLockersHost();
app.Run();
