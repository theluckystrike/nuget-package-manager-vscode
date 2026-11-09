# Private feeds

The sources come from your `nuget.config` files: the one in the folder, those in its parent folders, and your user file (`~/.nuget/NuGet/NuGet.Config`, or `%APPDATA%\NuGet\NuGet.Config` on Windows). `<clear />` and disabled sources are respected.

- Azure Artifacts: any user name, and a personal access token with Packaging (Read).
- GitHub Packages: your GitHub user name, and a token with `read:packages`.
- Other v3 feeds: the user name and password or token of that feed.

Run the command NuGet: Set User Name and Token for a Feed. The token goes to VS Code's secret storage and is sent only to that feed. A `ClearTextPassword` in `nuget.config` (also `%ENV_VAR%`) is used as it is. An encrypted `Password` (Windows only) cannot be read here, so paste the token once.

If a feed answers 401, the manager says which feed needs a token.
