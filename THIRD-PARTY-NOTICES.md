# Third-party notices

UCENTH Vision Intelligence's original application code is licensed under MIT, copyright 2026 UCENTH — Universal Central Host. That license does not replace third-party licenses or Google service terms.

## Runtime dependencies

- **@google/genai 2.24.0** — Apache-2.0. Google Gen AI SDK. Source and license: https://github.com/googleapis/js-genai
- **sharp 0.35.5** — Apache-2.0 for the JavaScript/native binding. Source and license: https://github.com/lovell/sharp
- **pdfjs-dist 6.3.289** — Apache-2.0. Mozilla's PDF.js, used only for page counting and text extraction with script evaluation disabled; no rendering or scripting sandbox is loaded. Source and license: https://github.com/mozilla/pdf.js
- **mammoth 1.13.0** — BSD-2-Clause. Reads Word (.docx) paragraphs, headings, lists and tables from the document XML; it does not execute macros or embedded content. Source and license: https://github.com/mwilliamson/mammoth.js. Its transitive dependencies (including jszip, dual-licensed MIT OR GPL-3.0-or-later and used here under MIT) are listed in `DEPENDENCY-LICENSES.md`.
- **Sharp's platform image libraries** — separate licenses. The Windows x64 package installed for this review declares **Apache-2.0 AND LGPL-3.0-or-later**. Other platform packages in the lockfile declare LGPL-3.0-or-later and, in some cases, MIT in addition to Apache. See each installed package's license files and https://github.com/lovell/sharp-libvips for the distributed library source/build information. libvips upstream itself is LGPL-2.1-or-later: https://github.com/libvips/libvips

The MIT license can apply to UCENTH's original source while these separately installed libraries retain their terms. Do not describe the whole dependency tree as MIT. This release distributes application source and a lockfile, not node_modules or native library binaries. If you redistribute bundled native binaries or modified libraries, retain their notices and meet their corresponding-source/relinking obligations as applicable.

## Development tools

- **Playwright** — Apache-2.0. https://github.com/microsoft/playwright
- **jszip** (development only, MIT OR GPL-3.0-or-later, used under MIT) builds synthetic Word test fixtures. https://github.com/Stuk/jszip
- Google Chrome is used for local acceptance testing. It is not included in the release.

The locked transitive dependency license inventory is in `DEPENDENCY-LICENSES.md`. Package license fields are an inventory, not substitutes for the full upstream license texts. `npm ci` retrieves the packages, including their license files. Keep those notices if redistributing dependencies.

## Service and media boundary

Google Cloud / Gemini is a separately operated hosted service, subject to Google's terms and pricing. Model weights are not included or claimed to be open source. UCENTH Vision Intelligence's screenshot depicts the original empty scanner interface; no private capture or third-party product photograph is distributed. Public photographs used during private acceptance testing are excluded from this source release.
