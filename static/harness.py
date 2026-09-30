# harness.py - runs inside Pyodide (browser) for the web practice site.
# Mirrors runner.py (local exams): same syntax check, same file name in
# tracebacks, same output normalisation. Time limits are enforced by the page,
# which terminates the worker if a test runs too long.
import base64
import io
import os
import sys
import traceback

SOURCE_NAME = "__tester__.python3"
MAX_OUTPUT_CHARS = 256_000
MAX_FIGURES = 4                      # figures shown after a run (not graded)
os.environ["MPLBACKEND"] = "Agg"     # matplotlib draws into memory, never to a window


class _OutputLimit(BaseException):
    """BaseException, so a student's `except Exception` cannot swallow it."""


class _CappedOut(io.StringIO):
    def write(self, s):
        room = MAX_OUTPUT_CHARS - self.tell()
        if len(s) > room:
            super().write(s[:max(room, 0)])
            raise _OutputLimit()
        return super().write(s)


def syntax_check(code):
    try:
        compile(code, SOURCE_NAME, "exec")
        return None
    except SyntaxError as e:
        line = (e.text or "").rstrip("\n")
        caret = ""
        if e.offset and line:
            caret = "\n" + " " * (4 + max(e.offset - 1, 0)) + "^"
        return (f'  File "{SOURCE_NAME}", line {e.lineno}\n    {line}{caret}\n'
                f"{type(e).__name__}: {e.msg}")
    except (ValueError, OverflowError) as e:
        return f"{type(e).__name__}: {e}"


def _figures(capture):
    """PNG images (base64) of the matplotlib figures the program left open, if
    it used matplotlib. Figures are always closed so they do not pile up."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    out = []
    try:
        if capture:
            for num in plt.get_fignums()[:MAX_FIGURES]:
                buf = io.BytesIO()
                plt.figure(num).savefig(buf, format="png", dpi=80, bbox_inches="tight")
                out.append(base64.b64encode(buf.getvalue()).decode("ascii"))
    except Exception:  # noqa: BLE001 - a broken figure must not break the test result
        out = []
    finally:
        plt.close("all")
    return out


def run_test(program, stdin, capture=False):
    """Returns [output, status, figures] with status 'ok' or 'error'; figures
    (base64 PNGs) only when capture is true and the program used matplotlib."""
    out = _CappedOut()
    saved = sys.stdin, sys.stdout, sys.stderr
    sys.stdin, sys.stdout, sys.stderr = io.StringIO(stdin), out, out
    status, extra = "ok", ""
    try:
        exec(compile(program, SOURCE_NAME, "exec"), {"__name__": "__main__"})
    except SystemExit as e:
        if e.code not in (None, 0):
            status = "error"
            if not isinstance(e.code, int):
                extra = str(e.code) + "\n"
    except _OutputLimit:
        status, extra = "error", "\n***Output limit exceeded***"
    except BaseException as e:  # noqa: B902 - report everything, like a real run
        status, extra = "error", _format(e)
    finally:
        sys.stdin, sys.stdout, sys.stderr = saved
    return [out.getvalue() + extra, status, _figures(capture)]


def _format(e):
    tb = e.__traceback__.tb_next if e.__traceback__ else None   # hide this harness frame
    return "".join(traceback.format_exception(type(e), e, tb))
