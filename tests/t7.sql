SELECT DISTINCT job FROM mitarbeiter ORDER BY job;
SELECT TO_CHAR(eintritt, 'YYYY') jahr, COUNT(*) anz FROM mitarbeiter GROUP BY TO_CHAR(eintritt, 'YYYY') ORDER BY jahr;
SELECT abt_id, COUNT(DISTINCT job) jobs FROM mitarbeiter GROUP BY abt_id ORDER BY abt_id NULLS FIRST;
SELECT MAX(COUNT(*)) FROM mitarbeiter GROUP BY abt_id;
SELECT x.abt, x.n FROM (SELECT abt_id abt, COUNT(*) n FROM mitarbeiter GROUP BY abt_id) x WHERE x.n > 1;
SELECT nachname FROM mitarbeiter NATURAL JOIN abteilung WHERE ort = 'Köln';
SELECT nachname, ROUND(SYSDATE - eintritt) > 0 FROM mitarbeiter WHERE ROWNUM = 1;
SELECT nachname FROM mitarbeiter WHERE nachname LIKE 'B%' OR vorname IN ('Eva', 'Finn') AND eintritt BETWEEN DATE '2019-01-01' AND DATE '2023-12-31';
SELECT job, AVG(gehalt) schnitt FROM mitarbeiter GROUP BY job HAVING AVG(gehalt) > 4000 ORDER BY schnitt;
CREATE SEQUENCE s_t START WITH 10;
CREATE TABLE t_def (id NUMBER DEFAULT s_t.NEXTVAL PRIMARY KEY, txt VARCHAR2(10), aktiv BOOLEAN DEFAULT TRUE);
INSERT INTO t_def (txt) VALUES ('a');
INSERT INTO t_def (txt) SELECT nachname FROM mitarbeiter WHERE abt_id = 30;
SELECT * FROM t_def;
DECLARE
  r t_def%ROWTYPE;
  b BOOLEAN := FALSE;
  v NUMBER;
  FUNCTION doppelt(x NUMBER, y NUMBER DEFAULT 2) RETURN NUMBER IS BEGIN RETURN x * y; END;
  FUNCTION ist_gerade(x NUMBER) RETURN BOOLEAN IS BEGIN RETURN MOD(x, 2) = 0; END;
  PROCEDURE p(t VARCHAR2) IS BEGIN DBMS_OUTPUT.PUT_LINE('p: ' || t); END;
BEGIN
  r.id := 99; r.txt := 'rec'; r.aktiv := FALSE;
  INSERT INTO t_def VALUES r;
  r.txt := 'rec2';
  UPDATE t_def SET ROW = r WHERE id = 99;
  UPDATE t_def SET txt = 'x' WHERE id = 10 RETURNING id INTO v;
  p(doppelt(21) || ' / ' || doppelt(2, 5) || ' / ret ' || v);
  IF ist_gerade(4) AND NOT b THEN p('gerade'); END IF;
  SELECT * INTO r FROM t_def WHERE id = 99;
  p(r.txt);
  DBMS_OUTPUT.PUT_LINE(NULL);
  p(CASE WHEN b IS NULL THEN 'null' ELSE 'nicht null' END);
END;
/
SELECT id, txt, aktiv FROM t_def ORDER BY id;
CREATE OR REPLACE PACKAGE ov AS
  FUNCTION f(a NUMBER) RETURN VARCHAR2;
  FUNCTION f(a NUMBER, b NUMBER) RETURN VARCHAR2;
  CURSOR c_all IS SELECT txt FROM t_def;
END;
/
CREATE OR REPLACE PACKAGE BODY ov AS
  FUNCTION f(a NUMBER) RETURN VARCHAR2 IS BEGIN RETURN 'eins'; END;
  FUNCTION f(a NUMBER, b NUMBER) RETURN VARCHAR2 IS BEGIN RETURN 'zwei'; END;
END;
/
BEGIN DBMS_OUTPUT.PUT_LINE(ov.f(1) || ov.f(1,2)); FOR r IN ov.c_all LOOP DBMS_OUTPUT.PUT(r.txt || ' '); END LOOP; DBMS_OUTPUT.NEW_LINE; END;
/
CREATE OR REPLACE PROCEDURE broken IS BEGIN x := 1 END;
/
SHOW ERRORS
CREATE OR REPLACE TRIGGER trg_bad AFTER INSERT ON t_def BEGIN DBMS_OUTPUT.PUT_LINE(:NEW.id); END;
/
SELECT name, type, line, text FROM user_errors;
SELECT abt_id, nachname, gehalt FROM mitarbeiter m1 WHERE gehalt > ALL (SELECT gehalt FROM mitarbeiter m2 WHERE m2.abt_id = 10);
SELECT COUNT(*) FROM mitarbeiter WHERE chef_id IS NOT NULL;
SELECT 10/3, 1/3*3, 0.1+0.2, 2**3 FROM dual;
