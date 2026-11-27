---
'@johnhenry/browsermesh-ingress': patch
---

The CLI no longer refuses an option value that starts with `--`: a pod id is base64url text and about one in four thousand begins with `--`, so `--names-allow <id>=*` failed with "needs a value" for those. In the separate form an option's value is now the next argument whatever it starts with; it counts as missing only at the end of the arguments or when the next argument is itself a known option. `--option=value` is documented as the form that is safe for any value, and the README examples use it for `--map` and `--names-allow` (#470).
