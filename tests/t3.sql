CREATE TABLE konto (nr NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, inhaber VARCHAR2(20) NOT NULL, saldo NUMBER(10,2) DEFAULT 0);
CREATE TABLE buchung_log (id NUMBER, nr NUMBER, alt NUMBER, neu NUMBER, art VARCHAR2(10), zeit DATE);
CREATE SEQUENCE seq_log START WITH 1 INCREMENT BY 1;
INSERT INTO konto (inhaber, saldo) VALUES ('Muster', 100);
INSERT INTO konto (inhaber) VALUES ('Elias');
INSERT INTO konto VALUES (5, 'x', 1);
SELECT * FROM konto;
CREATE OR REPLACE TRIGGER trg_konto
  BEFORE INSERT OR UPDATE OF saldo ON konto
  FOR EACH ROW
  WHEN (NEW.saldo < 0)
BEGIN
  RAISE_APPLICATION_ERROR(-20001, 'Saldo darf nicht negativ sein: ' || :NEW.saldo);
END;
/
CREATE OR REPLACE TRIGGER trg_konto_log
  AFTER UPDATE ON konto FOR EACH ROW
BEGIN
  INSERT INTO buchung_log VALUES (seq_log.NEXTVAL, :OLD.nr, :OLD.saldo, :NEW.saldo, CASE WHEN UPDATING THEN 'UPD' END, SYSDATE);
END;
/
CREATE OR REPLACE PROCEDURE ueberweisen(p_von IN NUMBER, p_an IN NUMBER, p_betrag IN NUMBER, p_status OUT VARCHAR2) AS
  v_saldo konto.saldo%TYPE;
  e_deckung EXCEPTION;
BEGIN
  SELECT saldo INTO v_saldo FROM konto WHERE nr = p_von;
  IF v_saldo < p_betrag THEN
    RAISE e_deckung;
  END IF;
  UPDATE konto SET saldo = saldo - p_betrag WHERE nr = p_von;
  UPDATE konto SET saldo = saldo + p_betrag WHERE nr = p_an;
  p_status := 'OK';
EXCEPTION
  WHEN e_deckung THEN p_status := 'Deckung fehlt';
END ueberweisen;
/
DECLARE
  s VARCHAR2(50);
BEGIN
  ueberweisen(1, 2, 30, s);
  DBMS_OUTPUT.PUT_LINE('1: ' || s);
  ueberweisen(p_von => 1, p_an => 2, p_betrag => 500, p_status => s);
  DBMS_OUTPUT.PUT_LINE('2: ' || s);
END;
/
SELECT * FROM konto;
SELECT id, nr, alt, neu, art FROM buchung_log;
UPDATE konto SET saldo = -1 WHERE nr = 1;
CREATE OR REPLACE FUNCTION fakultaet(n NUMBER) RETURN NUMBER IS
BEGIN
  IF n <= 1 THEN RETURN 1; END IF;
  RETURN n * fakultaet(n - 1);
END;
/
SELECT fakultaet(10) FROM dual;
EXEC DBMS_OUTPUT.PUT_LINE('exec: ' || fakultaet(5));
EXEC ueberweisen(1,2,3);
BEGIN fakultaet(3); END;
/
CREATE OR REPLACE PACKAGE bank AS
  g_zaehler NUMBER := 0;
  PROCEDURE einzahlen(p_nr NUMBER, p_betrag NUMBER);
  FUNCTION summe RETURN NUMBER;
END bank;
/
CREATE OR REPLACE PACKAGE BODY bank AS
  PROCEDURE log_intern(t VARCHAR2) IS BEGIN DBMS_OUTPUT.PUT_LINE('[bank] ' || t); END;
  PROCEDURE einzahlen(p_nr NUMBER, p_betrag NUMBER) IS
  BEGIN
    UPDATE konto SET saldo = saldo + p_betrag WHERE nr = p_nr;
    g_zaehler := g_zaehler + 1;
    log_intern('Einzahlung Nr. ' || g_zaehler);
  END;
  FUNCTION summe RETURN NUMBER IS v NUMBER; BEGIN SELECT SUM(saldo) INTO v FROM konto; RETURN v; END;
END bank;
/
BEGIN bank.einzahlen(1, 10); bank.einzahlen(2, 5); DBMS_OUTPUT.PUT_LINE('Summe: ' || bank.summe || ', Zähler ' || bank.g_zaehler); END;
/
BEGIN bank.log_intern('x'); END;
/
SELECT bank.summe FROM dual;
DECLARE
  TYPE t_namen IS TABLE OF VARCHAR2(30) INDEX BY PLS_INTEGER;
  TYPE t_liste IS TABLE OF NUMBER;
  TYPE t_rec IS RECORD (nr NUMBER, name VARCHAR2(20));
  TYPE t_recs IS TABLE OF t_rec;
  n t_namen; l t_liste := t_liste(5, 3, 8); r t_recs;
  i PLS_INTEGER;
BEGIN
  n(10) := 'zehn'; n(2) := 'zwei'; n(7) := 'sieben';
  i := n.FIRST;
  WHILE i IS NOT NULL LOOP DBMS_OUTPUT.PUT_LINE(i || '=' || n(i)); i := n.NEXT(i); END LOOP;
  l.EXTEND; l(l.LAST) := 42;
  DBMS_OUTPUT.PUT_LINE('count=' || l.COUNT || ' last=' || l(4));
  SELECT nr, inhaber BULK COLLECT INTO r FROM konto ORDER BY nr;
  FOR k IN 1 .. r.COUNT LOOP DBMS_OUTPUT.PUT_LINE(r(k).nr || ' ' || r(k).name); END LOOP;
  DBMS_OUTPUT.PUT_LINE(n(99));
EXCEPTION WHEN NO_DATA_FOUND THEN DBMS_OUTPUT.PUT_LINE('ndf ' || SQLCODE);
END;
/
DECLARE x NUMBER; BEGIN x := 1/0; END;
/
DECLARE x NUMBER(2); BEGIN x := 123; END;
/
DECLARE x VARCHAR2(3); BEGIN x := 'abcd'; EXCEPTION WHEN VALUE_ERROR THEN DBMS_OUTPUT.PUT_LINE('VE: ' || SQLERRM); END;
/
BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLE dyn_t (a NUMBER)';
  EXECUTE IMMEDIATE 'INSERT INTO dyn_t VALUES (:1)' USING 42;
  FOR r IN (SELECT a FROM dyn_t) LOOP DBMS_OUTPUT.PUT_LINE('dyn ' || r.a); END LOOP;
END;
/
CREATE OR REPLACE TRIGGER trg_mut AFTER INSERT ON dyn_t FOR EACH ROW
DECLARE c NUMBER;
BEGIN SELECT COUNT(*) INTO c FROM dyn_t; END;
/
INSERT INTO dyn_t SELECT 1 FROM dual;
INSERT INTO dyn_t VALUES (2);
MERGE INTO konto k USING (SELECT 1 nr, 999 s FROM dual UNION ALL SELECT 9, 1 FROM dual) q ON (k.nr = q.nr)
WHEN MATCHED THEN UPDATE SET k.saldo = q.s
WHEN NOT MATCHED THEN INSERT (inhaber, saldo) VALUES ('Neu', q.s);
SELECT * FROM konto ORDER BY nr;
CREATE VIEW v_konten AS SELECT nr, UPPER(inhaber) AS inhaber, saldo * 1.19 brutto FROM konto;
SELECT * FROM v_konten;
CREATE VIEW v_bad AS SELECT COUNT(*) FROM konto;
DESC konto
SELECT object_name, object_type, status FROM user_objects ORDER BY object_type, object_name;
SELECT seq_log.CURRVAL, seq_log.NEXTVAL FROM dual;
