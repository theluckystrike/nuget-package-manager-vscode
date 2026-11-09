# Update outdated packages

The Updates tab lists every package reference with a newer version, in every project of the folder.

- Tick the rows you want and choose Update selected, or choose Update all.
- A plain version such as `8.0.1` moves to the newest version. A range such as `[8.0,9.0)` stays inside the range; the row says when a newer version is outside it.
- Prereleases appear only when the Prerelease box is ticked, or when the project already uses a prerelease.
- With central package management the new version is written to `Directory.Packages.props`, once for every project that uses it.

After the change the extension runs `dotnet restore` when the .NET SDK is installed. Without it, the files are saved and the message says that restore was skipped.
