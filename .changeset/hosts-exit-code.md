---
'@johnhenry/browsermesh-meshctl': minor
---

`meshctl hosts` now exits non-zero when EVERY listed host failed (#432). This is a behaviour change: `hosts` used to exit 0 even when every host refused this identity, so a script that checked only the exit code missed "nothing worked". The document is unchanged (every host's entry is still printed, a failed one with its own `error`). The exit code is 0 if at least one host answered; if all failed, the code they share (3 if all were refusals such as `WSH_REFUSED`, 6 if all timed out), or 1 when they failed in different ways. The README's exit-code table and `--help` say so. Minor rather than patch because meshctl is 0.x and an exit code a script may branch on changes.
