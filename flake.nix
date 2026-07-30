{
  description = "TeleUploader — Nix build";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # TeleUploader package
        teleuploader = pkgs.stdenvNoCC.mkDerivation rec {
          pname = "teleuploader";
          version = "1.0.0";

          src = ./.;

          nativeBuildInputs = [
            pkgs.bun
            pkgs.makeBinaryWrapper
          ];

          # Bun cache di sandbox — prevent online fetch
          # Karena bun.lock sudah di repo, bun install --frozen-lockfile
          # akan pake cache, tapi di Nix sandbox gak ada internet.
          # Solusi: offline flag
          preBuild = ''
            export HOME=$TMPDIR/home
            mkdir -p $HOME
            export BUN_INSTALL=$HOME/.bun
          '';

          buildPhase = ''
            echo "=== Installing dependencies ==="
            bun install --frozen-lockfile --ignore-scripts 2>&1

            echo "=== Building ==="
            bun run build 2>&1
          '';

          installPhase = ''
            mkdir -p $out/bin $out/share/teleuploader

            # Copy dist files
            cp -r dist $out/share/teleuploader/dist
            cp src/home.html $out/share/teleuploader/ 2>/dev/null || true
            cp schema.sql $out/share/teleuploader/ 2>/dev/null || true

            # Wrap with bun from Nix store (dependency sharing!)
            # Note: NO --chdir — systemd WorkingDirectory controls this
            makeBinaryWrapper ${pkgs.bun}/bin/bun $out/bin/teleuploader \
              --add-flags "$out/share/teleuploader/dist/index.js" \
              --set-default NODE_ENV production \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun ]}

            # Also create the migrate wrapper
            makeBinaryWrapper ${pkgs.bun}/bin/bun $out/bin/teleuploader-migrate \
              --add-flags "$out/share/teleuploader/dist/migrate.js" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.bun ]}
          '';

          meta = {
            description = "Telegram file uploader backend (S3 → Telegram)";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.linux;
          };
        };
      in {
        packages = {
          inherit teleuploader;
          default = teleuploader;
        };

        # Dev shell with bun for local development
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.bun
            pkgs.nodejs_22
          ];
        };
      });
}
