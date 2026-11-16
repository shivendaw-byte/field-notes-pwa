"""Tiny helper: apply exact-match replacements, failing loudly if a target is missing or ambiguous."""
import sys, io
def patch(path, reps):
    s = io.open(path, encoding='utf-8', newline='').read()
    crlf = '\r\n' in s
    if crlf: s = s.replace('\r\n', '\n')
    for i, (a, b) in enumerate(reps):
        n = s.count(a)
        if n != 1:
            sys.exit("patch %s #%d: expected 1 match, found %d\n---\n%s" % (path, i, n, a[:200]))
        s = s.replace(a, b)
    if crlf: s = s.replace('\n', '\r\n')
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print("patched", path, len(reps))
