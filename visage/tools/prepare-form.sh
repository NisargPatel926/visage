#!/usr/bin/env bash
# Prepare an official USCIS PDF for programmatic filling.
#
# USCIS forms ship AES-encrypted (empty user password, restrictive permission
# flags). pdf-lib cannot decrypt them: every object lookup returns undefined and
# loading dies with "Expected instance of PDFDict, but got instance of
# undefined". qpdf strips the encryption; the result is byte-identical in
# content and fills normally.
#
# This runs ONCE per form edition at vendor time, never per request.
#
#   tools/prepare-form.sh assets/forms/i-485/2025-01-20/i-485.pdf
#
# Produces i-485.decrypted.pdf alongside the input.
set -euo pipefail

src="${1:?usage: prepare-form.sh <form.pdf>}"
dst="${src%.pdf}.decrypted.pdf"

command -v qpdf >/dev/null || { echo "qpdf is required (apt-get install qpdf)" >&2; exit 1; }

qpdf --decrypt --object-streams=disable "$src" "$dst"
echo "wrote $dst"
