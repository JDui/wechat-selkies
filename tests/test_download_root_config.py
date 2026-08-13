from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]


class DownloadRootConfigTests(unittest.TestCase):
    def test_both_nginx_server_blocks_use_download_placeholder(self):
        source = (ROOT / "root" / "defaults" / "default.conf").read_text(encoding="utf-8")
        self.assertEqual(source.count("alias REPLACE_DOWNLOADS_PATH;"), 2)

    def test_init_defaults_download_root_without_repurposing_upload_path(self):
        source = (ROOT / "root" / "etc" / "s6-overlay" / "s6-rc.d" / "init-nginx" / "run").read_text(encoding="utf-8")
        self.assertIn('SELKIES_DOWNLOAD_ROOT="${SELKIES_DOWNLOAD_ROOT:-/}"', source)
        self.assertIn('FILE_MANAGER_PATH="${FILE_MANAGER_PATH:-$HOME/Desktop}"', source)
        self.assertIn('SELKIES_DOWNLOAD_ROOT="$(normalize_download_root "$SELKIES_DOWNLOAD_ROOT")"', source)
        self.assertIn('DOWNLOAD_ALIAS_PATH="$SELKIES_DOWNLOAD_ROOT"', source)
        self.assertIn('DOWNLOAD_ALIAS_PATH="${DOWNLOAD_ALIAS_PATH}/"', source)
        self.assertIn('escape_sed_replacement "$DOWNLOAD_ALIAS_PATH"', source)
        self.assertIn('if [ "$DOWNLOAD_ALIAS_PATH" != "/" ]; then', source)
        self.assertIn("s/[\\/&|]/\\\\&/g", source)
        self.assertIn('if [ "$SELKIES_DOWNLOAD_ROOT" != "/" ]; then', source)
        self.assertIn('while [[ "$root" == */ ]]; do', source)
        self.assertIn('s6-setuidgid abc mkdir -p "${FILE_MANAGER_PATH}"', source)


if __name__ == "__main__":
    unittest.main()
