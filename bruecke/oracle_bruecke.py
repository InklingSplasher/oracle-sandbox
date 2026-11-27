#!/usr/bin/env python3
"""
Oracle-Brücke für die Oracle-Sandbox
====================================

Kleiner lokaler HTTP-Dienst, über den die Sandbox (eine HTML-Datei im Browser)
SQL und PL/SQL auf einem echten Oracle-Server ausführt. Browser können weder
Oracle Net noch ODBC direkt sprechen – die Brücke übersetzt.

Treiber:
  * Oracle Net über python-oracledb (Thin-Modus, kein Instant Client nötig)
        py -m pip install oracledb
  * ODBC über pyodbc (vorhandene DSN oder Verbindungszeichenfolge)
        py -m pip install pyodbc

Start:
  py oracle_bruecke.py                 # lauscht auf 127.0.0.1:8765
  py oracle_bruecke.py --port 9000     # anderer Port

Die Brücke lauscht nur auf dem eigenen Rechner und verlangt einen Schlüssel,
der beim Start angezeigt wird. Ohne Schlüssel könnte jede Webseite, die du
gerade offen hast, über deine offene Datenbanksitzung SQL absetzen.
"""
import argparse
import datetime
import decimal
import json
import re
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0"
ORA_RE = re.compile(r"(ORA|PLS|SP2|TNS|DPY|DPI)-\d{4,5}")


# --------------------------------------------------------------------------
# Werte für JSON aufbereiten
# --------------------------------------------------------------------------
def fmt_value(v):
    if v is None:
        return None, "str"
    if isinstance(v, bool):
        return ("1" if v else "0"), "num"
    if isinstance(v, int):
        return str(v), "num"
    if isinstance(v, float):
        s = repr(v)
        if s.endswith(".0"):
            s = s[:-2]
        return s, "num"
    if isinstance(v, decimal.Decimal):
        s = format(v.normalize(), "f") if v == v.to_integral_value() else format(v, "f").rstrip("0").rstrip(".")
        return s, "num"
    if isinstance(v, datetime.datetime):
        if v.hour == 0 and v.minute == 0 and v.second == 0 and v.microsecond == 0:
            return v.strftime("%d.%m.%Y"), "date"
        if v.microsecond:
            return v.strftime("%d.%m.%Y %H:%M:%S,%f"), "date"
        return v.strftime("%d.%m.%Y %H:%M:%S"), "date"
    if isinstance(v, datetime.date):
        return v.strftime("%d.%m.%Y"), "date"
    if isinstance(v, datetime.timedelta):
        return str(v), "str"
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        return (b[:2000].hex().upper() + ("…" if len(b) > 2000 else "")), "str"
    if hasattr(v, "read"):  # LOB
        try:
            return fmt_value(v.read())
        except Exception as e:  # noqa: BLE001
            return "<LOB: %s>" % e, "str"
    return str(v), "str"


def line_of(text, offset):
    if not offset or offset < 0:
        return 0
    return text.count("\n", 0, min(offset, len(text)))


# --------------------------------------------------------------------------
# Treiber
# --------------------------------------------------------------------------
class Backend:
    """Gemeinsame Logik: Ausführen, Ergebnis abholen, Fehler übersetzen."""

    kind = "?"
    supports_output = False

    def __init__(self):
        self.conn = None
        self.cur = None
        self.info = {}

    # Treiber-spezifisch
    def connect(self, p):
        raise NotImplementedError

    def error_info(self, e):
        raise NotImplementedError

    def fetch_output(self):
        return []

    def cancel(self):
        try:
            if self.conn is not None and hasattr(self.conn, "cancel"):
                self.conn.cancel()
            elif self.cur is not None and hasattr(self.cur, "cancel"):
                self.cur.cancel()
        except Exception:  # noqa: BLE001
            pass

    def close(self):
        try:
            if self.conn is not None:
                self.conn.rollback()
                self.conn.close()
        except Exception:  # noqa: BLE001
            pass
        self.conn = None

    # Gemeinsam
    def run(self, stmt, limit):
        text = stmt.get("text", "")
        res = {"line": stmt.get("line", 1)}
        cur = self.conn.cursor()
        self.cur = cur
        try:
            cur.execute(text)
            if cur.description:
                cols = [d[0] for d in cur.description]
                rows, kinds, more = [], ["str"] * len(cols), False
                for i, r in enumerate(cur):
                    if i >= limit:
                        more = True
                        break
                    out = []
                    for k, v in enumerate(r):
                        s, kd = fmt_value(v)
                        if s is not None and kinds[k] == "str" and kd != "str":
                            kinds[k] = kd
                        out.append(s)
                    rows.append(out)
                res["grid"] = {"cols": cols, "rows": rows, "kinds": ["num" if k == "num" else "str" for k in kinds], "more": more}
            else:
                rc = cur.rowcount
                res["rowcount"] = rc if isinstance(rc, int) else -1
            if stmt.get("kind") == "plsql" and stmt.get("obj"):
                errs = self.compile_errors(stmt["obj"])
                if errs:
                    res["compile"] = errs
        except Exception as e:  # noqa: BLE001
            info = self.error_info(e)
            if info is None:
                raise
            code, msg, off = info
            res["error"] = {"code": code, "message": msg, "lineOffset": line_of(text, off) if off else None}
        finally:
            try:
                cur.close()
            except Exception:  # noqa: BLE001
                pass
            self.cur = None
        if self.supports_output:
            try:
                out = self.fetch_output()
                if out:
                    res["output"] = out
            except Exception:  # noqa: BLE001
                pass
        return res

    def query(self, sql):
        cur = self.conn.cursor()
        try:
            cur.execute(sql)
            return cur.fetchall()
        finally:
            cur.close()

    def compile_errors(self, obj):
        name, typ = obj.get("name", "").upper(), obj.get("type", "").upper()
        if not name or not re.fullmatch(r"[A-Z][A-Z0-9_$#]*", name) or not re.fullmatch(r"[A-Z ]+", typ):
            return None
        try:
            rows = self.query(
                "SELECT line, position, text FROM user_errors WHERE name = '%s' AND type = '%s' ORDER BY sequence" % (name, typ)
            )
        except Exception:  # noqa: BLE001
            return None
        return [{"line": int(r[0]), "pos": int(r[1]), "text": str(r[2]).strip()} for r in rows] or None

    def tx_open(self):
        try:
            rows = self.query("SELECT dbms_transaction.local_transaction_id FROM dual")
            return bool(rows and rows[0][0])
        except Exception:  # noqa: BLE001
            return None


class OracleNet(Backend):
    kind = "oracledb"
    supports_output = True

    def connect(self, p):
        try:
            import oracledb
        except ImportError as e:
            raise RuntimeError("python-oracledb nicht verfügbar (%s) – installieren mit:  py -m pip install oracledb" % e)
        self.mod = oracledb
        oracledb.defaults.fetch_lobs = False
        oracledb.defaults.fetch_decimals = True
        dsn = (p.get("dsn") or "").strip()
        if not dsn:
            host = (p.get("host") or "localhost").strip()
            port = int(p.get("port") or 1521)
            service = (p.get("service") or "").strip()
            if not service:
                raise RuntimeError("Service-Name fehlt (z. B. FREEPDB1, XEPDB1 oder ORCL).")
            dsn = "%s:%d/%s" % (host, port, service)
        self.conn = oracledb.connect(user=p.get("user"), password=p.get("password"), dsn=dsn)
        self.conn.autocommit = False
        cur = self.conn.cursor()
        cur.callproc("dbms_output.enable", [None])
        cur.close()
        self.info = {"server": getattr(self.conn, "version", ""), "dsn": dsn}

    def error_info(self, e):
        if not isinstance(e, self.mod.Error):
            return None
        err = e.args[0] if e.args else None
        msg = getattr(err, "message", None) or str(e)
        code = getattr(err, "full_code", None)
        if not code:
            m = ORA_RE.search(msg)
            code = m.group(0) if m else "FEHLER"
        msg = re.sub(r"^\s*" + re.escape(code) + r":\s*", "", msg.strip())
        return code, msg, getattr(err, "offset", 0)

    def fetch_output(self):
        cur = self.conn.cursor()
        try:
            lines_var = cur.arrayvar(str, 200)
            num_var = cur.var(int)
            out = []
            while len(out) < 20000:
                num_var.setvalue(0, 200)
                cur.callproc("dbms_output.get_lines", (lines_var, num_var))
                n = num_var.getvalue()
                out.extend((l or "") for l in lines_var.getvalue()[:n])
                if n < 200:
                    break
            return out
        finally:
            cur.close()


class Odbc(Backend):
    kind = "odbc"
    supports_output = False  # DBMS_OUTPUT braucht OUT-Parameter, die pyodbc nicht kann

    def connect(self, p):
        try:
            import pyodbc
        except ImportError as e:
            raise RuntimeError("pyodbc nicht verfügbar (%s) – installieren mit:  py -m pip install pyodbc" % e)
        self.mod = pyodbc
        cs = (p.get("odbc") or "").strip()
        if not cs:
            raise RuntimeError("DSN oder ODBC-Verbindungszeichenfolge fehlt.")
        if "=" not in cs:
            cs = "DSN=" + cs
        if p.get("user") and "UID=" not in cs.upper():
            cs += ";UID=" + p["user"]
        if p.get("password") and "PWD=" not in cs.upper():
            cs += ";PWD=" + p["password"]
        self.conn = pyodbc.connect(cs, autocommit=False)
        try:
            ver = self.conn.getinfo(pyodbc.SQL_DBMS_VER)
        except Exception:  # noqa: BLE001
            ver = ""
        self.info = {"server": ver, "dsn": re.sub(r"PWD=[^;]*", "PWD=***", cs, flags=re.I)}

    def error_info(self, e):
        if not isinstance(e, self.mod.Error):
            return None
        msg = e.args[1] if len(e.args) > 1 else str(e)
        msg = re.sub(r"^(\[[^\]]*\])+\s*", "", str(msg)).strip()
        m = ORA_RE.search(msg)
        code = m.group(0) if m else (e.args[0] if e.args else "ODBC")
        msg = re.sub(r"^\s*" + re.escape(str(code)) + r":\s*", "", msg[m.start():] if m else msg)
        msg = re.sub(r"\s*\(SQLExecDirectW\)\s*$", "", msg)
        return str(code), msg, 0


BACKENDS = {"oracledb": OracleNet, "odbc": Odbc}


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class State:
    def __init__(self, token):
        self.token = token
        self.backend = None
        self.lock = threading.Lock()
        self.user = ""


def make_handler(state):
    class H(BaseHTTPRequestHandler):
        server_version = "OracleBruecke/" + VERSION

        def log_message(self, fmt, *args):  # ruhiger als Standard
            sys.stderr.write("  %s\n" % (fmt % args))

        def cors(self):
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Token")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

        def reply(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):  # noqa: N802
            self.send_response(204)
            self.cors()
            self.end_headers()

        def authed(self):
            if state.token and not secrets.compare_digest(self.headers.get("X-Token", ""), state.token):
                self.reply(401, {"ok": False, "error": "Falscher oder fehlender Schlüssel. Er steht im Fenster der Brücke."})
                return False
            return True

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 20 * 1024 * 1024:
                raise ValueError("Anfrage zu groß")
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")

        def status(self):
            b = state.backend
            return {"ok": True, "bridge": VERSION, "connected": bool(b and b.conn), "driver": b.kind if b else None,
                    "user": state.user, "server": (b.info.get("server") if b else ""), "dsn": (b.info.get("dsn") if b else ""),
                    "drivers": avail_drivers()}

        def do_GET(self):  # noqa: N802
            if self.path.rstrip("/") in ("", "/status"):
                if not self.authed():
                    return
                return self.reply(200, self.status())
            self.reply(404, {"ok": False, "error": "Unbekannter Pfad"})

        def do_POST(self):  # noqa: N802
            if not self.authed():
                return
            try:
                p = self.body()
            except Exception as e:  # noqa: BLE001
                return self.reply(400, {"ok": False, "error": "Ungültige Anfrage: %s" % e})
            path = self.path.rstrip("/")
            if path == "/cancel":
                if state.backend:
                    state.backend.cancel()
                return self.reply(200, {"ok": True})
            with state.lock:
                if path == "/connect":
                    return self.connect(p)
                if path == "/disconnect":
                    if state.backend:
                        state.backend.close()
                    state.backend = None
                    state.user = ""
                    return self.reply(200, {"ok": True})
                if path == "/sql":
                    return self.sql(p)
            self.reply(404, {"ok": False, "error": "Unbekannter Pfad"})

        def connect(self, p):
            drv = p.get("driver") or "oracledb"
            if drv not in BACKENDS:
                return self.reply(400, {"ok": False, "error": "Unbekannter Treiber: %s" % drv})
            if state.backend:
                state.backend.close()
                state.backend = None
            b = BACKENDS[drv]()
            try:
                b.connect(p)
            except Exception as e:  # noqa: BLE001
                info = None
                try:
                    info = b.error_info(e) if hasattr(b, "mod") else None
                except Exception:  # noqa: BLE001
                    info = None
                msg = ("%s: %s" % (info[0], info[1])) if info else str(e)
                return self.reply(200, {"ok": False, "error": msg})
            state.backend = b
            try:
                state.user = str(b.query("SELECT USER FROM dual")[0][0])
            except Exception:  # noqa: BLE001
                state.user = (p.get("user") or "").upper()
            print("  verbunden: %s über %s (%s)" % (state.user, drv, b.info.get("dsn", "")))
            self.reply(200, self.status())

        def sql(self, p):
            b = state.backend
            if not b or not b.conn:
                return self.reply(409, {"ok": False, "error": "Die Brücke ist nicht mit einer Datenbank verbunden."})
            limit = max(1, min(int(p.get("limit") or 500), 100000))
            items = []
            for st in p.get("statements") or []:
                if st.get("kind") == "commit":
                    try:
                        b.conn.commit()
                        items.append({"line": st.get("line", 1), "rowcount": -1})
                    except Exception as e:  # noqa: BLE001
                        code, msg, _ = b.error_info(e) or ("FEHLER", str(e), 0)
                        items.append({"line": st.get("line", 1), "error": {"code": code, "message": msg}})
                    continue
                try:
                    items.append(b.run(st, limit))
                except Exception as e:  # noqa: BLE001  – Verbindung weg o. Ä.
                    items.append({"line": st.get("line", 1), "error": {"code": "BRÜCKE", "message": str(e)}})
                    break
            tx = b.tx_open() if p.get("tx", True) else None
            self.reply(200, {"ok": True, "items": items, "tx": tx, "output": b.supports_output})

    return H


def avail_drivers():
    out = []
    for name, mod in (("oracledb", "oracledb"), ("odbc", "pyodbc")):
        try:
            __import__(mod)
            out.append(name)
        except Exception:  # noqa: BLE001
            pass
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Oracle-Brücke für die Oracle-Sandbox")
    ap.add_argument("--host", default="127.0.0.1", help="Adresse (Standard: nur dieser Rechner)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--token", default=None, help="eigenen Schlüssel festlegen")
    ap.add_argument("--ohne-schluessel", action="store_true", help="Schlüsselprüfung abschalten (nicht empfohlen)")
    a = ap.parse_args(argv)
    token = "" if a.ohne_schluessel else (a.token or secrets.token_hex(4).upper())
    state = State(token)
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(state))
    drivers = avail_drivers()
    print("Oracle-Brücke %s läuft auf http://%s:%d" % (VERSION, a.host, a.port))
    print("Schlüssel:  %s" % (token or "(keiner)"))
    print("Treiber:    %s" % (", ".join(drivers) if drivers else "KEINER – py -m pip install oracledb"))
    print("Beenden mit Strg+C.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if state.backend:
            state.backend.close()
        srv.server_close()


if __name__ == "__main__":
    main()
