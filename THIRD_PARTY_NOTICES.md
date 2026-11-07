# Third-Party Notices

This project uses open-source software. License obligations are preserved below.

## Application dependencies (npm)

| Package | Version | License |
|---|---|---|
| express | 4.22.x | MIT |
| socket.io | 4.8.x | MIT |
| hbs | 4.x | MIT |
| handlebars | 4.7.x | MIT |
| archiver | 3.x | MIT |
| morgan | 1.12.x | MIT |
| debug | 2.x / 4.x | MIT |
| http-errors | 2.x | MIT |
| cross-env | 7.x | MIT |
| dotenv | latest | BSD-2-Clause |

All npm packages are installed via `package-lock.json`; individual license texts
are available inside each package's `node_modules/<pkg>/LICENSE*` file.

## GNU Wget

The project invokes (and may bundle) **GNU Wget**, which is distributed under the
**GNU General Public License v3.0 (GPLv3)**.

- Source: https://ftp.gnu.org/gnu/wget/
- License: https://www.gnu.org/licenses/gpl-3.0.html

The bundled `wget.exe` in this repository is a Windows build of GNU Wget and is
subject to GPLv3. Distribution of this binary carries the obligations of GPLv3,
including providing the corresponding source. Please refer to the GNU Wget
source distribution for the complete license text.

## Handlebars.js

`hbs` depends on `handlebars` (MIT). Note: as of this writing, npm audit reports
known advisories in `handlebars` for which **no fixed version exists** across the
4.x line. This project uses only static, first-party templates; user input never
reaches the template compiler, so the practical exploitability is considered low.
Re-evaluate when upstream fixes land.

## Original code attribution

The MIT license header in `LICENSE.md` retains the original copyright notice:
**Copyright (c) 2019 Ahmed Ibrhim** (original Website Downloader author), alongside
the current maintainer's notice.

## Fonts

The UI loads the **Inter** font family from Google Fonts
(SIL Open Font License 1.1). See https://rsms.me/inter/ for license details.
