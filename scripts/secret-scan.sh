#!/bin/sh
set -eu

git ls-files --cached --others --exclude-standard | while IFS= read -r file; do
    [ -f "$file" ] || continue
    [ "$file" = scripts/secret-scan.sh ] && continue
    if grep -I -n -E '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{32,})' "$file"; then
        echo "Possible secret found in $file" >&2
        exit 1
    fi
    case "$file" in
        .env|.env.*) [ "$file" = '.env.example' ] || { echo "Forbidden environment file: $file" >&2; exit 1; } ;;
    esac
done
