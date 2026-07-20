{
  description = "singify — UltraStar karaoke in Spotify via Spicetify (Bun + TypeScript)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      # Add your architecture here if it isn't listed.
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      # The built Spicetify extension. Consumed by nixos-config as a flake input
      # (src = inputs.singify.packages.<system>.default; name = "karaoke.js"), so
      # deploying is just `nix flake update singify` + rebuild — no copying the
      # bundle around. Builds with only bun + the source: the extension graph has
      # zero npm deps (it uses the Spicetify.React global, never imports react).
      packages = forAll (pkgs: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "singify-karaoke";
          version = "0.1.0";
          src = ./.;
          nativeBuildInputs = [ pkgs.bun ];
          # Offline, hermetic build — no network, no node_modules.
          buildPhase = ''
            export HOME="$TMPDIR"
            export DO_NOT_TRACK=1
            bun build ./src/index.ts --target browser --outfile karaoke.js
          '';
          installPhase = ''
            mkdir -p "$out"
            cp karaoke.js "$out/karaoke.js"
          '';
        };
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # Bun is the whole toolchain — runtime, bundler, test runner, package manager.
          packages = [ pkgs.bun ];
          shellHook = ''
            echo "singify dev shell · bun $(bun --version)"
            echo "  bun install      install deps"
            echo "  bun test         run the test suite"
            echo "  bun run dev      browser harness → http://localhost:3000"
            echo "  bun run build    bundle → dist/karaoke.js"
            echo "  bun run helper   localhost USDB+cache bridge → :4455"
          '';
        };
      });
    };
}
