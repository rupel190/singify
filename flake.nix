{
  description = "singify — UltraStar karaoke in Spotify via Spicetify (Bun + TypeScript)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      # Add your architecture here if it isn't listed.
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # Bun is the whole toolchain — runtime, bundler, test runner, package manager.
          packages = [ pkgs.bun ];
          shellHook = ''
            echo "singify dev shell · bun $(bun --version)"
            echo "  bun install      install deps"
            echo "  bun test         run the 50 core tests"
            echo "  bun run dev      browser harness → http://localhost:3000"
            echo "  bun run build    bundle → dist/karaoke.js"
          '';
        };
      });
    };
}
