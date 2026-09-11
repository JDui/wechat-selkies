from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]


class DownloadRootConfigTests(unittest.TestCase):
    def test_both_nginx_server_blocks_use_download_placeholder(self):
        source = (ROOT / "root" / "defaults" / "default.conf").read_text(encoding="utf-8")
        self.assertEqual(source.count("alias REPLACE_DOWNLOADS_PATH;"), 2)
        self.assertEqual(source.count("location = SUBFOLDERfiles {"), 2)
        self.assertEqual(source.count("return 301 SUBFOLDERfiles/;"), 2)
        self.assertEqual(source.count("location = SUBFOLDERfiles/ssl {"), 2)
        self.assertEqual(source.count("location SUBFOLDERfiles/ssl/ {"), 2)
        self.assertEqual(source.count("location SUBFOLDERfiles/. {"), 2)
        self.assertEqual(source.count("return 403;"), 6)
        self.assertEqual(source.count("location SUBFOLDERfiles/ {"), 2)
        self.assertNotIn("location SUBFOLDERfiles {", source)
        self.assertEqual(source.count("error_page 403 =403 SUBFOLDERnginx/download-forbidden.html;"), 8)
        self.assertEqual(source.count("error_page 401 =200 PW_PREFIXauth/_pin_page;"), 8)

    def test_init_defaults_download_root_without_repurposing_upload_path(self):
        source = (ROOT / "root" / "etc" / "s6-overlay" / "s6-rc.d" / "init-nginx" / "run").read_text(encoding="utf-8")
        self.assertIn('SELKIES_DOWNLOAD_ROOT="${SELKIES_DOWNLOAD_ROOT:-/config}"', source)
        self.assertIn('FILE_MANAGER_PATH="${FILE_MANAGER_PATH:-$HOME/Desktop}"', source)
        self.assertIn('SELKIES_DOWNLOAD_ROOT="$(normalize_download_root "$SELKIES_DOWNLOAD_ROOT")"', source)
        self.assertIn('DOWNLOAD_ALIAS_PATH="$SELKIES_DOWNLOAD_ROOT"', source)
        self.assertIn('DOWNLOAD_ALIAS_PATH="${DOWNLOAD_ALIAS_PATH}/"', source)
        self.assertIn('DOWNLOAD_ROOT_B64="$(printf \'%s\' "$SELKIES_DOWNLOAD_ROOT" | base64 | tr -d \'\\r\\n\')"', source)
        self.assertIn('escape_sed_replacement "$DOWNLOAD_ALIAS_PATH"', source)
        self.assertIn("s/[\\/&|]/\\\\&/g", source)
        self.assertIn('if [ "$SELKIES_DOWNLOAD_ROOT" != "/" ]; then', source)
        self.assertIn('while [[ "$root" == */ ]]; do', source)
        self.assertIn('s6-setuidgid abc mkdir -p "${FILE_MANAGER_PATH}"', source)
        self.assertIn("REPLACE_DOWNLOADS_PATH_B64", source)
        self.assertIn("/usr/share/selkies/web/nginx/footer.html", source)
        self.assertIn('DOWNLOADS_ENABLED="false"', source)
        self.assertIn('if [[ $SELKIES_FILE_TRANSFERS == *"download"* ]] && [[ ${HARDEN_DESKTOP,,} != "true" ]]; then', source)
        self.assertIn('id -u abc', source)
        self.assertIn('NGINX_MAIN_CONFIG="/etc/nginx/nginx.conf"', source)
        self.assertIn("user abc;", source)
        self.assertNotRegex(source, r"(?:chmod|chown)[^\n]*xwechat_files")

    def test_browser_overlay_uses_safe_relative_favorites(self):
        footer = (ROOT / "root" / "usr" / "share" / "selkies" / "selkies-dashboard" / "nginx" / "footer.html").read_text(encoding="utf-8")
        browser = (ROOT / "root" / "usr" / "share" / "selkies" / "selkies-dashboard" / "nginx" / "download-browser.js").read_text(encoding="utf-8")
        self.assertIn('data-download-root-b64="REPLACE_DOWNLOADS_PATH_B64"', footer)
        self.assertIn('data-download-prefix="SUBFOLDERfiles/"', footer)
        self.assertRegex(footer, r'src="SUBFOLDERnginx/download-browser\.js\?v=\d+\.\d+"')
        self.assertIn("localStorage", browser)
        self.assertIn("MAX_FAVORITES = 20", browser)
        self.assertIn("normalizeRelativePath", browser)
        self.assertIn('segment === ".."', browser)
        self.assertIn("processDirectoryListing", browser)
        self.assertIn("heading.textContent", browser)
        self.assertIn('row.style.display = "none"', browser)
        self.assertIn("heading.parentNode.insertBefore(browserRoot, heading.nextSibling)", browser)
        self.assertNotIn("innerHTML", browser)

    def test_forbidden_page_has_safe_navigation(self):
        page = (ROOT / "root" / "usr" / "share" / "selkies" / "selkies-dashboard" / "nginx" / "download-forbidden.html").read_text(encoding="utf-8")
        self.assertIn("无法访问此下载目录", page)
        self.assertIn('href="SUBFOLDERfiles/"', page)
        self.assertNotIn('href="../files/"', page)
        self.assertNotIn('window.location.href = "../files/"', page)
        self.assertIn("window.history.back()", page)

        init = (ROOT / "root" / "etc" / "s6-overlay" / "s6-rc.d" / "init-nginx" / "run").read_text(encoding="utf-8")
        self.assertIn("download-forbidden.html", init)
        self.assertIn("if [ -f /usr/share/selkies/web/nginx/download-forbidden.html ]; then", init)
        self.assertIn('s|SUBFOLDER|$(escape_sed_replacement "$SFOLDER")|g', init)

    def test_project_defaults_documented(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("| `SELKIES_DOWNLOAD_ROOT` | `/config` |", readme)
        self.assertIn("abc", readme)
        self.assertIn("ssl", readme)
        self.assertIn("根级隐藏目录", readme)
        self.assertIn("PIN", readme)
        self.assertIn("SELKIES_DOWNLOAD_ROOT=${SELKIES_DOWNLOAD_ROOT:-/config}", compose)
        self.assertIn('ENV SELKIES_DOWNLOAD_ROOT="/config"', dockerfile)


if __name__ == "__main__":
    unittest.main()
