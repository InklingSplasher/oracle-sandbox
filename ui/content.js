// ===== Inhalte: Beispielschema, Beispiele, Spickzettel =====
const SEED_SQL = `CREATE TABLE studiengang (
  sg_id  NUMBER(4)     CONSTRAINT pk_studiengang PRIMARY KEY,
  name    VARCHAR2(30)  NOT NULL,
  standort     VARCHAR2(30)
);

CREATE TABLE studierende (
  matr_nr     NUMBER(6)     CONSTRAINT pk_studierende PRIMARY KEY,
  vorname   VARCHAR2(30),
  nachname  VARCHAR2(30)  NOT NULL,
  rolle       VARCHAR2(20),
  verguetung    NUMBER(8,2)   CONSTRAINT ck_st_verguetung CHECK (verguetung > 0),
  studienbeginn  DATE          DEFAULT SYSDATE,
  mentor_id   NUMBER(6)     CONSTRAINT fk_st_mentor REFERENCES studierende (matr_nr),
  sg_id    NUMBER(4)     CONSTRAINT fk_st_studiengang REFERENCES studiengang (sg_id)
);

CREATE TABLE verguetung_log (
  log_id    NUMBER        CONSTRAINT pk_verguetung_log PRIMARY KEY,
  matr_nr     NUMBER(6),
  alt       NUMBER(8,2),
  neu       NUMBER(8,2),
  geaendert DATE
);

CREATE SEQUENCE seq_studierende START WITH 100 INCREMENT BY 1;
CREATE SEQUENCE seq_verguetung_log START WITH 1 INCREMENT BY 1;

INSERT INTO studiengang VALUES (10, 'Wirtschaftsinformatik', 'Elmshorn');
INSERT INTO studiengang VALUES (20, 'Angewandte Informatik', 'Elmshorn');
INSERT INTO studiengang VALUES (30, 'Betriebswirtschaftslehre', 'Hamburg');
INSERT INTO studiengang VALUES (40, 'Wirtschaftsingenieurwesen', NULL);

INSERT INTO studierende VALUES (1, 'Anna',  'Berg',  'SPRECHER', 1650, DATE '2022-10-01', NULL, 10);
INSERT INTO studierende VALUES (2, 'Ben',   'Claus', 'TUTOR',    1500, DATE '2023-10-01', 1, 20);
INSERT INTO studierende VALUES (3, 'Clara', 'Dahl',  'TUTOR',    1400, DATE '2023-10-01', 2, 20);
INSERT INTO studierende VALUES (4, 'Dora',  'Eck',   'STUDENT',  1250, DATE '2024-10-01', 2, 20);
INSERT INTO studierende VALUES (5, 'Eva',   'Fuchs', 'TUTOR',    1350, DATE '2023-04-01', 1, 10);
INSERT INTO studierende VALUES (6, 'Finn',  'Graf',  'STUDENT',  1200, DATE '2025-04-01', 5, 10);
INSERT INTO studierende VALUES (7, 'Greta', 'Hahn',  'STUDENT',  1300, DATE '2024-04-01', 1, 30);
INSERT INTO studierende VALUES (8, 'Hugo',  'Ilg',   'GAST',     1100, DATE '2025-10-01', 3, NULL);
COMMIT;

CREATE OR REPLACE VIEW v_studierende AS
  SELECT m.matr_nr, m.vorname || ' ' || m.nachname AS name, m.rolle, m.verguetung,
         a.name AS studiengang, a.standort
  FROM studierende m
  LEFT JOIN studiengang a ON a.sg_id = m.sg_id;

CREATE OR REPLACE VIEW v_studiengang_statistik AS
  SELECT a.name AS studiengang, COUNT(m.matr_nr) AS anzahl,
         ROUND(AVG(m.verguetung), 2) AS schnitt, MAX(m.verguetung) AS maximum
  FROM studiengang a
  LEFT JOIN studierende m ON m.sg_id = a.sg_id
  GROUP BY a.name;

CREATE OR REPLACE FUNCTION jahresverguetung (p_matr_nr IN studierende.matr_nr%TYPE)
  RETURN NUMBER
IS
  v_verguetung studierende.verguetung%TYPE;
BEGIN
  SELECT verguetung INTO v_verguetung FROM studierende WHERE matr_nr = p_matr_nr;
  RETURN v_verguetung * 12;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RETURN NULL;
END jahresverguetung;
/

CREATE OR REPLACE PROCEDURE verguetung_erhoehen (
  p_sg_id  IN studiengang.sg_id%TYPE,
  p_prozent IN NUMBER DEFAULT 5
) IS
BEGIN
  UPDATE studierende
     SET verguetung = ROUND(verguetung * (1 + p_prozent / 100), 2)
   WHERE sg_id = p_sg_id;
  DBMS_OUTPUT.PUT_LINE(SQL%ROWCOUNT || ' Vergütungen um ' || p_prozent || ' % erhöht.');
END verguetung_erhoehen;
/

CREATE OR REPLACE TRIGGER trg_verguetung_log
  AFTER UPDATE OF verguetung ON studierende
  FOR EACH ROW
BEGIN
  INSERT INTO verguetung_log (log_id, matr_nr, alt, neu, geaendert)
  VALUES (seq_verguetung_log.NEXTVAL, :OLD.matr_nr, :OLD.verguetung, :NEW.verguetung, SYSDATE);
END;
/
`;

const START_SHEET = `-- Willkommen! Strg+Enter führt die Anweisung unter dem Cursor aus, F5 das ganze Skript.
-- Links siehst du alle Tabellen, Views, Prozeduren usw. – ein Klick zeigt Inhalt und Definition.
-- Fertige Beispiele findest du oben im Beispiele-Menü, Syntax im Spickzettel.

`;

const EXAMPLES = [
  { name: 'Joins & Gruppierung', sql: `-- Benötigt das Beispielschema (Menü → Beispielschema laden)
SELECT a.name AS studiengang, COUNT(m.matr_nr) AS anzahl, ROUND(AVG(m.verguetung), 2) AS schnitt
FROM studiengang a
LEFT JOIN studierende m ON m.sg_id = a.sg_id
GROUP BY a.name
HAVING COUNT(m.matr_nr) > 0
ORDER BY anzahl DESC;

-- Oracle-Altsyntax für Outer Join mit (+)
SELECT m.nachname, c.nachname AS mentor
FROM studierende m, studierende c
WHERE m.mentor_id = c.matr_nr (+)
ORDER BY m.matr_nr;

-- Unterabfrage: wer bekommt mehr als der Durchschnitt?
SELECT nachname, verguetung
FROM studierende
WHERE verguetung > (SELECT AVG(verguetung) FROM studierende)
ORDER BY verguetung DESC;

-- Korrelierte Unterabfrage: höchste Vergütung je Studiengang
SELECT m.nachname, m.verguetung, m.sg_id
FROM studierende m
WHERE m.verguetung = (SELECT MAX(x.verguetung) FROM studierende x WHERE x.sg_id = m.sg_id);
` },
  { name: 'Analytische Funktionen', sql: `SELECT nachname, sg_id, verguetung,
       RANK()       OVER (PARTITION BY sg_id ORDER BY verguetung DESC) AS rang,
       SUM(verguetung)  OVER (PARTITION BY sg_id)                     AS summe_abt,
       ROUND(verguetung / SUM(verguetung) OVER () * 100, 1)                AS anteil_prozent,
       LAG(verguetung)  OVER (ORDER BY studienbeginn)                       AS vorgaenger
FROM studierende
ORDER BY sg_id, rang;

-- Top-N je Gruppe
SELECT * FROM (
  SELECT nachname, sg_id, verguetung,
         ROW_NUMBER() OVER (PARTITION BY sg_id ORDER BY verguetung DESC) AS rn
  FROM studierende
)
WHERE rn = 1;
` },
  { name: 'Hierarchie (CONNECT BY)', sql: `SELECT LPAD(' ', 2 * (LEVEL - 1)) || nachname AS mentoring,
       LEVEL,
       SYS_CONNECT_BY_PATH(nachname, ' / ') AS pfad
FROM studierende
START WITH mentor_id IS NULL
CONNECT BY PRIOR matr_nr = mentor_id
ORDER SIBLINGS BY nachname;
` },
  { name: 'Cursor & Exceptions', sql: `DECLARE
  CURSOR c_st (p_sg NUMBER) IS
    SELECT nachname, verguetung FROM studierende WHERE sg_id = p_sg ORDER BY verguetung DESC;
  v_st    c_st%ROWTYPE;
  v_summe NUMBER := 0;
BEGIN
  OPEN c_st(20);
  LOOP
    FETCH c_st INTO v_st;
    EXIT WHEN c_st%NOTFOUND;
    v_summe := v_summe + v_st.verguetung;
    DBMS_OUTPUT.PUT_LINE(c_st%ROWCOUNT || '. ' || v_st.nachname || ': ' || v_st.verguetung);
  END LOOP;
  CLOSE c_st;
  DBMS_OUTPUT.PUT_LINE('Summe: ' || v_summe);

  -- Cursor-FOR-Schleife: öffnet, holt und schließt automatisch
  FOR r IN (SELECT name FROM studiengang ORDER BY name) LOOP
    DBMS_OUTPUT.PUT_LINE('Studiengang ' || r.name);
  END LOOP;

  -- provoziert NO_DATA_FOUND
  SELECT verguetung INTO v_summe FROM studierende WHERE matr_nr = 999;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    DBMS_OUTPUT.PUT_LINE('Abgefangen: ' || SQLCODE || ' / ' || SQLERRM);
END;
/
` },
  { name: 'Eigene Exceptions', sql: `DECLARE
  e_zu_hoch   EXCEPTION;
  e_fk_fehlt   EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_fk_fehlt, -2291);
  v_verguetung     studierende.verguetung%TYPE;
BEGIN
  SELECT verguetung INTO v_verguetung FROM studierende WHERE matr_nr = 1;
  IF v_verguetung > 1600 THEN
    RAISE e_zu_hoch;
  END IF;
EXCEPTION
  WHEN e_zu_hoch THEN
    DBMS_OUTPUT.PUT_LINE('Vergütung zu hoch: ' || v_verguetung);
    BEGIN
      INSERT INTO studierende (matr_nr, nachname, sg_id) VALUES (500, 'Test', 99);
    EXCEPTION
      WHEN e_fk_fehlt THEN DBMS_OUTPUT.PUT_LINE('Studiengang 99 gibt es nicht (ORA-02291).');
    END;
END;
/

-- Fachlicher Fehler für den Aufrufer
BEGIN
  RAISE_APPLICATION_ERROR(-20001, 'Rückmeldung zum Semester fehlt.');
END;
/
` },
  { name: 'Prozedur mit OUT-Parameter', sql: `CREATE OR REPLACE PROCEDURE studiengang_info (
  p_sg_id  IN  studiengang.sg_id%TYPE,
  p_anzahl  OUT NUMBER,
  p_schnitt OUT NUMBER
) IS
BEGIN
  SELECT COUNT(*), AVG(verguetung)
    INTO p_anzahl, p_schnitt
    FROM studierende
   WHERE sg_id = p_sg_id;
END studiengang_info;
/

DECLARE
  v_anz NUMBER;
  v_avg NUMBER;
BEGIN
  studiengang_info(20, v_anz, v_avg);
  DBMS_OUTPUT.PUT_LINE('Anzahl: ' || v_anz || ', Schnitt: ' || ROUND(v_avg, 2));

  studiengang_info(p_sg_id => 10, p_anzahl => v_anz, p_schnitt => v_avg);   -- benannte Parameter
  DBMS_OUTPUT.PUT_LINE('Wirtschaftsinformatik: ' || v_anz);
END;
/

-- Funktionen lassen sich auch in SQL verwenden
SELECT nachname, jahresverguetung(matr_nr) AS jahr FROM studierende ORDER BY jahr DESC;
` },
  { name: 'Trigger & Log', sql: `-- Der Trigger TRG_VERGUETUNG_LOG aus dem Beispielschema protokolliert jede Änderung der Vergütung
EXEC verguetung_erhoehen(20, 10);

SELECT * FROM verguetung_log ORDER BY log_id;

-- BEFORE-Trigger mit Prüfung und Korrektur von :NEW
CREATE OR REPLACE TRIGGER trg_st_check
  BEFORE INSERT OR UPDATE ON studierende
  FOR EACH ROW
BEGIN
  :NEW.nachname := INITCAP(:NEW.nachname);
  IF INSERTING AND :NEW.matr_nr IS NULL THEN
    :NEW.matr_nr := seq_studierende.NEXTVAL;
  END IF;
  IF :NEW.verguetung > 3000 THEN
    RAISE_APPLICATION_ERROR(-20010, 'Vergütung unplausibel: ' || :NEW.verguetung);
  END IF;
END;
/

INSERT INTO studierende (nachname, verguetung, sg_id) VALUES ('müller', 1200, 10);
SELECT matr_nr, nachname FROM studierende WHERE nachname = 'Müller';
UPDATE studierende SET verguetung = 5000 WHERE matr_nr = 1;
ROLLBACK;
` },
  { name: 'Package', sql: `CREATE OR REPLACE PACKAGE studium_pkg AS
  g_aufrufe NUMBER := 0;                        -- öffentliche Package-Variable
  FUNCTION anzahl (p_sg_id NUMBER) RETURN NUMBER;
  PROCEDURE ausgabe (p_sg_id NUMBER);
END studium_pkg;
/

CREATE OR REPLACE PACKAGE BODY studium_pkg AS
  PROCEDURE zaehlen IS                          -- privat: nicht in der Spezifikation
  BEGIN
    g_aufrufe := g_aufrufe + 1;
  END;

  FUNCTION anzahl (p_sg_id NUMBER) RETURN NUMBER IS
    v NUMBER;
  BEGIN
    zaehlen;
    SELECT COUNT(*) INTO v FROM studierende WHERE sg_id = p_sg_id;
    RETURN v;
  END;

  PROCEDURE ausgabe (p_sg_id NUMBER) IS
  BEGIN
    zaehlen;
    FOR r IN (SELECT nachname FROM studierende WHERE sg_id = p_sg_id) LOOP
      DBMS_OUTPUT.PUT_LINE('- ' || r.nachname);
    END LOOP;
  END;
END studium_pkg;
/

BEGIN
  studium_pkg.ausgabe(20);
  DBMS_OUTPUT.PUT_LINE('Anzahl: ' || studium_pkg.anzahl(20));
  DBMS_OUTPUT.PUT_LINE('Aufrufe: ' || studium_pkg.g_aufrufe);
END;
/
` },
  { name: 'Collections & BULK COLLECT', sql: `DECLARE
  TYPE t_namen  IS TABLE OF VARCHAR2(30) INDEX BY PLS_INTEGER;   -- assoziatives Array
  TYPE t_zahlen IS TABLE OF NUMBER;                               -- Nested Table
  TYPE t_st     IS TABLE OF studierende%ROWTYPE;

  v_namen  t_namen;
  v_zahlen t_zahlen := t_zahlen(3, 1, 4);
  v_st     t_st;
  i        PLS_INTEGER;
BEGIN
  v_namen(10) := 'zehn';
  v_namen(2)  := 'zwei';
  i := v_namen.FIRST;
  WHILE i IS NOT NULL LOOP
    DBMS_OUTPUT.PUT_LINE(i || ' => ' || v_namen(i));
    i := v_namen.NEXT(i);
  END LOOP;

  v_zahlen.EXTEND;
  v_zahlen(v_zahlen.LAST) := 1;
  DBMS_OUTPUT.PUT_LINE('Elemente: ' || v_zahlen.COUNT);

  SELECT * BULK COLLECT INTO v_st FROM studierende WHERE sg_id = 20;
  FOR k IN 1 .. v_st.COUNT LOOP
    DBMS_OUTPUT.PUT_LINE(v_st(k).nachname || ' erhält ' || v_st(k).verguetung);
  END LOOP;

  FORALL k IN 1 .. v_st.COUNT
    UPDATE studierende SET verguetung = verguetung + 1 WHERE matr_nr = v_st(k).matr_nr;
  DBMS_OUTPUT.PUT_LINE(SQL%ROWCOUNT || ' Zeilen per FORALL geändert');
  ROLLBACK;
END;
/
` },
  { name: 'Transaktionen', sql: `UPDATE studierende SET verguetung = verguetung * 2 WHERE sg_id = 10;
SAVEPOINT nach_wi;
UPDATE studierende SET verguetung = verguetung * 2 WHERE sg_id = 20;
SELECT nachname, verguetung FROM studierende ORDER BY matr_nr;

ROLLBACK TO nach_wi;     -- nur die zweite Änderung zurücknehmen
SELECT nachname, verguetung FROM studierende ORDER BY matr_nr;

ROLLBACK;                      -- alles seit dem letzten COMMIT zurücknehmen
SELECT nachname, verguetung FROM studierende ORDER BY matr_nr;
` },
  { name: 'Data Dictionary', sql: `SELECT table_name, num_rows FROM user_tables ORDER BY table_name;

SELECT column_name, data_type, data_length, nullable
FROM user_tab_columns
WHERE table_name = 'STUDIERENDE'
ORDER BY column_id;

SELECT constraint_name, constraint_type, table_name, search_condition, r_constraint_name
FROM user_constraints
ORDER BY table_name;

SELECT object_name, object_type, status FROM user_objects ORDER BY object_type, object_name;

SELECT line, text FROM user_source WHERE name = 'JAHRESVERGUETUNG' ORDER BY line;

DESC studierende
` },
];

// Spickzettel: [Abschnitt, [[Titel, Code, Hinweis?], ...]]
const CHEAT = [
  ['Bedienung', [
    ['Ausführen', `-- Strg+Enter   Anweisung unter dem Cursor (oder Markierung)
-- F5 / Strg+Shift+Enter   ganzes Skript
-- PL/SQL-Blöcke, Prozeduren, Trigger mit einer Zeile "/" abschließen`, 'SQL-Anweisungen enden mit ;. Blöcke (BEGIN … END;) brauchen danach eine eigene Zeile mit /.'],
    ['Zeichenketten & Verkettung', `SELECT 'Bestellung Nr. ' || 42 AS text FROM dual;
-- 'einfache' Anführungszeichen = Text, "doppelte" = Bezeichner`, 'Leerstring \'\' ist in Oracle NULL!'],
    ['DUAL', `SELECT SYSDATE, USER, 7 * 6 FROM dual;`, 'DUAL ist die Ein-Zeilen-Hilfstabelle für Ausdrücke.'],
  ]],
  ['Tabellen (DDL)', [
    ['CREATE TABLE mit Constraints', `CREATE TABLE kunde (
  kunde_id  NUMBER(6)     CONSTRAINT pk_kunde PRIMARY KEY,
  name      VARCHAR2(50)  NOT NULL,
  email     VARCHAR2(100) CONSTRAINT uq_kunde_email UNIQUE,
  bonitaet  NUMBER(1)     CHECK (bonitaet BETWEEN 1 AND 6),
  angelegt  DATE          DEFAULT SYSDATE
);`],
    ['Fremdschlüssel', `CREATE TABLE bestellung (
  best_id   NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kunde_id  NUMBER(6) NOT NULL,
  betrag    NUMBER(10,2),
  CONSTRAINT fk_best_kunde FOREIGN KEY (kunde_id)
    REFERENCES kunde (kunde_id) ON DELETE CASCADE
);`, 'ON DELETE CASCADE löscht Kind-Datensätze mit; ON DELETE SET NULL setzt sie auf NULL.'],
    ['ALTER TABLE', `ALTER TABLE kunde ADD (telefon VARCHAR2(30));
ALTER TABLE kunde MODIFY (name VARCHAR2(80));
ALTER TABLE kunde RENAME COLUMN telefon TO tel;
ALTER TABLE kunde DROP COLUMN tel;
ALTER TABLE kunde ADD CONSTRAINT ck_name CHECK (name = INITCAP(name));
ALTER TABLE kunde DROP CONSTRAINT ck_name;`],
    ['Löschen & Leeren', `TRUNCATE TABLE bestellung;            -- alle Zeilen, ohne ROLLBACK
DROP TABLE bestellung;
DROP TABLE kunde CASCADE CONSTRAINTS;  -- inkl. Fremdschlüssel anderer Tabellen`],
    ['Sequenz & Identity', `CREATE SEQUENCE seq_kunde START WITH 1 INCREMENT BY 1;
INSERT INTO kunde (kunde_id, name) VALUES (seq_kunde.NEXTVAL, 'Meyer');
SELECT seq_kunde.CURRVAL FROM dual;`, 'Alternativ: Spalte NUMBER GENERATED ALWAYS AS IDENTITY.'],
    ['Datentypen', `NUMBER(p,s)   -- NUMBER(8,2): 6 Vor-, 2 Nachkommastellen
VARCHAR2(n)   -- variable Länge, Länge ist Pflicht
CHAR(n)       -- feste Länge, wird mit Leerzeichen aufgefüllt
DATE          -- Datum inkl. Uhrzeit (Sekunden)
TIMESTAMP     -- mit Sekundenbruchteilen
CLOB          -- langer Text`],
    ['Index', `CREATE INDEX ix_kunde_name ON kunde (name);
CREATE UNIQUE INDEX ux_kunde_mail ON kunde (email);
DROP INDEX ix_kunde_name;`],
  ]],
  ['Views', [
    ['View anlegen', `CREATE OR REPLACE VIEW v_kunde_umsatz AS
  SELECT k.name, COUNT(b.best_id) AS bestellungen, NVL(SUM(b.betrag), 0) AS umsatz
  FROM kunde k
  LEFT JOIN bestellung b ON b.kunde_id = k.kunde_id
  GROUP BY k.name;

SELECT * FROM v_kunde_umsatz;`, 'Berechnete Spalten brauchen einen Alias.'],
    ['Optionen', `CREATE OR REPLACE VIEW v_wirtschaftsinformatik AS
  SELECT * FROM studierende WHERE sg_id = 10
  WITH CHECK OPTION;          -- oder: WITH READ ONLY
DROP VIEW v_wirtschaftsinformatik;`],
  ]],
  ['Daten ändern (DML)', [
    ['INSERT', `INSERT INTO kunde (kunde_id, name) VALUES (1, 'Meyer');
INSERT INTO kunde VALUES (2, 'Schulz', NULL, 2, SYSDATE);
INSERT INTO kunde_archiv SELECT * FROM kunde WHERE angelegt < DATE '2025-01-01';`],
    ['UPDATE & DELETE', `UPDATE kunde SET bonitaet = 1, name = UPPER(name) WHERE kunde_id = 1;
UPDATE studierende m SET verguetung = (SELECT AVG(verguetung) FROM studierende x WHERE x.sg_id = m.sg_id)
 WHERE verguetung IS NULL;
DELETE FROM kunde WHERE kunde_id = 2;`],
    ['MERGE (Upsert)', `MERGE INTO kunde k
USING (SELECT 1 AS id, 'Meyer GmbH' AS name FROM dual) q
ON (k.kunde_id = q.id)
WHEN MATCHED THEN UPDATE SET k.name = q.name
WHEN NOT MATCHED THEN INSERT (kunde_id, name) VALUES (q.id, q.name);`],
    ['Transaktionen', `COMMIT;                  -- dauerhaft speichern
ROLLBACK;                -- seit letztem COMMIT zurücknehmen
SAVEPOINT sp1;
ROLLBACK TO sp1;`, 'DDL (CREATE, ALTER, DROP, TRUNCATE) committet automatisch.'],
  ]],
  ['Abfragen', [
    ['Grundgerüst', `SELECT   sg_id, COUNT(*) AS anzahl, AVG(verguetung) AS schnitt
FROM     studierende
WHERE    studienbeginn >= DATE '2024-01-01'
GROUP BY sg_id
HAVING   COUNT(*) > 1
ORDER BY schnitt DESC NULLS LAST;`, 'Reihenfolge der Auswertung: FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY.'],
    ['Joins', `SELECT m.nachname, a.name
FROM studierende m
JOIN studiengang a ON a.sg_id = m.sg_id;          -- INNER JOIN

SELECT a.name, m.nachname
FROM studiengang a
LEFT JOIN studierende m ON m.sg_id = a.sg_id;   -- auch Studiengänge ohne Studierende

SELECT m.nachname, a.name                          -- Oracle-Altsyntax
FROM studierende m, studiengang a
WHERE m.sg_id = a.sg_id (+);`, 'Tabellen-Alias ohne AS: FROM studierende m'],
    ['Unterabfragen', `SELECT * FROM studierende WHERE sg_id IN (SELECT sg_id FROM studiengang WHERE standort = 'Hamburg');
SELECT * FROM studiengang a WHERE NOT EXISTS (SELECT 1 FROM studierende m WHERE m.sg_id = a.sg_id);
SELECT nachname, (SELECT name FROM studiengang a WHERE a.sg_id = m.sg_id) AS abt FROM studierende m;`, 'Vorsicht: NOT IN mit NULL in der Unterabfrage liefert keine Zeile.'],
    ['Mengen-Operatoren', `SELECT sg_id FROM studiengang
MINUS                      -- auch: UNION, UNION ALL, INTERSECT
SELECT sg_id FROM studierende;`],
    ['Top-N', `SELECT * FROM studierende ORDER BY verguetung DESC FETCH FIRST 3 ROWS ONLY;
SELECT * FROM (SELECT * FROM studierende ORDER BY verguetung DESC) WHERE ROWNUM <= 3;`, 'ROWNUM wird vor ORDER BY vergeben – deshalb die Unterabfrage.'],
    ['WITH (CTE)', `WITH schnitt AS (
  SELECT sg_id, AVG(verguetung) AS avg_verguetung FROM studierende GROUP BY sg_id
)
SELECT m.nachname, m.verguetung, s.avg_verguetung
FROM studierende m JOIN schnitt s ON s.sg_id = m.sg_id
WHERE m.verguetung > s.avg_verguetung;`],
    ['Analytische Funktionen', `SELECT nachname, verguetung,
  ROW_NUMBER() OVER (ORDER BY verguetung DESC)              AS nr,
  RANK()       OVER (PARTITION BY sg_id ORDER BY verguetung DESC) AS rang,
  SUM(verguetung)  OVER (ORDER BY studienbeginn)                 AS laufende_summe,
  LAG(verguetung)  OVER (ORDER BY studienbeginn)                 AS vorher
FROM studierende;`],
    ['Hierarchie', `SELECT LEVEL, LPAD(' ', 2 * LEVEL) || nachname AS baum
FROM studierende
START WITH mentor_id IS NULL
CONNECT BY PRIOR matr_nr = mentor_id;`],
    ['CASE & DECODE', `SELECT nachname,
  CASE WHEN verguetung >= 1500 THEN 'hoch'
       WHEN verguetung >= 1300 THEN 'mittel'
       ELSE 'niedrig' END                    AS stufe,
  DECODE(sg_id, 10, 'WI', 20, 'AI', '??')  AS kuerzel
FROM studierende;`],
  ]],
  ['Funktionen', [
    ['Text', `UPPER('a')  LOWER('A')  INITCAP('max muster')
LENGTH('Oracle')         SUBSTR('Oracle', 2, 3)  -- 'rac'
INSTR('banana', 'an')    REPLACE('a-b', '-', '+')
TRIM('  x ')  LPAD('7', 3, '0')  RPAD('x', 3, '.')
'a' || 'b'   CONCAT('a', 'b')
REGEXP_LIKE(email, '^[^@]+@[^@]+$')  REGEXP_REPLACE('a1b2', '[0-9]', '')`],
    ['Zahlen', `ROUND(12.345, 1)  TRUNC(12.345, 1)  MOD(17, 5)
CEIL(1.2)  FLOOR(1.8)  ABS(-3)  POWER(2, 10)  SQRT(16)
GREATEST(1, 5, 3)  LEAST(1, 5, 3)`],
    ['Datum', `SYSDATE   SYSTIMESTAMP   DATE '2026-11-26'
SYSDATE + 7                       -- in 7 Tagen
datum2 - datum1                   -- Differenz in Tagen
ADD_MONTHS(SYSDATE, 3)  MONTHS_BETWEEN(d1, d2)
LAST_DAY(SYSDATE)  NEXT_DAY(SYSDATE, 'MONTAG')
TRUNC(SYSDATE)  TRUNC(SYSDATE, 'MM')  EXTRACT(YEAR FROM SYSDATE)`],
    ['Umwandlung', `TO_CHAR(SYSDATE, 'DD.MM.YYYY HH24:MI')
TO_CHAR(1234.5, 'FM9G990D00')         -- 1.234,50
TO_DATE('24.12.2026', 'DD.MM.YYYY')
TO_NUMBER('42')   CAST('42' AS NUMBER)`, 'Formatelemente: YYYY MM DD HH24 MI SS, MON, MONTH, DY, DAY, IW, Q'],
    ['NULL-Behandlung', `NVL(provision, 0)
NVL2(provision, 'ja', 'nein')
COALESCE(tel_mobil, tel_fest, 'keine')
NULLIF(a, b)
WHERE spalte IS NULL / IS NOT NULL      -- nie: = NULL`],
    ['Aggregate', `COUNT(*)  COUNT(spalte)  COUNT(DISTINCT spalte)
SUM  AVG  MIN  MAX  MEDIAN  STDDEV
LISTAGG(nachname, ', ') WITHIN GROUP (ORDER BY nachname)`],
  ]],
  ['PL/SQL-Grundlagen', [
    ['Block-Aufbau', `DECLARE
  v_name   VARCHAR2(50);
  v_zahl   NUMBER := 0;
  c_mwst   CONSTANT NUMBER := 0.19;
BEGIN
  v_zahl := v_zahl + 1;
  DBMS_OUTPUT.PUT_LINE('Wert: ' || v_zahl);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE(SQLERRM);
END;
/`, 'Zuweisung mit :=, Vergleich mit =.'],
    ['%TYPE und %ROWTYPE', `DECLARE
  v_verguetung studierende.verguetung%TYPE;
  v_st     studierende%ROWTYPE;
BEGIN
  SELECT * INTO v_st FROM studierende WHERE matr_nr = 1;
  v_verguetung := v_st.verguetung;
END;
/`],
    ['SELECT INTO', `SELECT nachname, verguetung
  INTO v_name, v_verguetung
  FROM studierende
 WHERE matr_nr = 3;`, 'Genau eine Zeile – sonst NO_DATA_FOUND bzw. TOO_MANY_ROWS.'],
    ['IF & CASE', `IF v_verguetung > 1500 THEN
  v_stufe := 'hoch';
ELSIF v_verguetung > 1200 THEN
  v_stufe := 'mittel';
ELSE
  v_stufe := 'niedrig';
END IF;

CASE v_note
  WHEN 1 THEN DBMS_OUTPUT.PUT_LINE('sehr gut');
  WHEN 2 THEN DBMS_OUTPUT.PUT_LINE('gut');
  ELSE DBMS_OUTPUT.PUT_LINE('anders');
END CASE;`, 'ELSIF – nicht ELSE IF.'],
    ['Schleifen', `LOOP
  i := i + 1;
  EXIT WHEN i > 10;
END LOOP;

WHILE i <= 10 LOOP
  i := i + 1;
END LOOP;

FOR i IN 1 .. 10 LOOP          -- REVERSE für rückwärts
  CONTINUE WHEN MOD(i, 2) = 0;
  DBMS_OUTPUT.PUT_LINE(i);
END LOOP;`],
    ['Ausgabe', `DBMS_OUTPUT.PUT_LINE('Text ' || zahl);
DBMS_OUTPUT.PUT('ohne ');  DBMS_OUTPUT.PUT_LINE('Umbruch');`, 'SET SERVEROUTPUT ON ist hier nicht nötig – die Ausgabe erscheint immer.'],
  ]],
  ['Cursor', [
    ['Expliziter Cursor', `DECLARE
  CURSOR c_st IS SELECT nachname, verguetung FROM studierende;
  v_st c_st%ROWTYPE;
BEGIN
  OPEN c_st;
  LOOP
    FETCH c_st INTO v_st;
    EXIT WHEN c_st%NOTFOUND;
    DBMS_OUTPUT.PUT_LINE(v_st.nachname);
  END LOOP;
  CLOSE c_st;
END;
/`],
    ['Cursor-FOR-Schleife', `BEGIN
  FOR r IN (SELECT nachname FROM studierende ORDER BY 1) LOOP
    DBMS_OUTPUT.PUT_LINE(r.nachname);
  END LOOP;
END;
/`, 'Öffnen, Holen und Schließen passiert automatisch.'],
    ['Cursor mit Parameter', `DECLARE
  CURSOR c_abt (p_sg NUMBER) IS
    SELECT nachname FROM studierende WHERE sg_id = p_sg;
BEGIN
  FOR r IN c_abt(20) LOOP
    DBMS_OUTPUT.PUT_LINE(r.nachname);
  END LOOP;
END;
/`],
    ['Attribute', `c%FOUND  c%NOTFOUND  c%ROWCOUNT  c%ISOPEN
SQL%ROWCOUNT   -- Zeilen der letzten DML-Anweisung
SQL%FOUND`],
    ['FOR UPDATE / CURRENT OF', `DECLARE
  CURSOR c IS SELECT verguetung FROM studierende FOR UPDATE;
BEGIN
  FOR r IN c LOOP
    UPDATE studierende SET verguetung = r.verguetung * 1.02 WHERE CURRENT OF c;
  END LOOP;
END;
/`],
    ['REF CURSOR', `DECLARE
  c SYS_REFCURSOR;
BEGIN
  OPEN c FOR SELECT * FROM studiengang;
  DBMS_SQL.RETURN_RESULT(c);      -- zeigt das Ergebnis als Tabelle
END;
/`],
  ]],
  ['Exceptions', [
    ['Vordefinierte', `NO_DATA_FOUND     -- ORA-01403  SELECT INTO ohne Treffer
TOO_MANY_ROWS     -- ORA-01422  SELECT INTO mit > 1 Zeile
ZERO_DIVIDE       -- ORA-01476
VALUE_ERROR       -- ORA-06502  Konvertierung / zu lang
DUP_VAL_ON_INDEX  -- ORA-00001  Unique verletzt
INVALID_CURSOR, CURSOR_ALREADY_OPEN, CASE_NOT_FOUND, OTHERS`],
    ['Eigene Exception', `DECLARE
  e_kein_geld EXCEPTION;
BEGIN
  IF v_saldo < 0 THEN
    RAISE e_kein_geld;
  END IF;
EXCEPTION
  WHEN e_kein_geld THEN
    DBMS_OUTPUT.PUT_LINE('Saldo negativ');
END;
/`],
    ['ORA-Code zuordnen', `DECLARE
  e_fk EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_fk, -2291);
BEGIN
  INSERT INTO studierende (matr_nr, nachname, sg_id) VALUES (900, 'X', 99);
EXCEPTION
  WHEN e_fk THEN DBMS_OUTPUT.PUT_LINE('Studiengang fehlt');
END;
/`],
    ['Fehler werfen', `RAISE_APPLICATION_ERROR(-20001, 'Eigene Fehlermeldung');   -- -20000 bis -20999
RAISE;            -- im Handler: aktuelle Exception weiterreichen
SQLCODE / SQLERRM -- Nummer und Text der aktuellen Exception`],
  ]],
  ['Prozeduren & Funktionen', [
    ['Prozedur', `CREATE OR REPLACE PROCEDURE erhoehe (
  p_id      IN  studierende.matr_nr%TYPE,
  p_prozent IN  NUMBER DEFAULT 5,
  p_neu     OUT NUMBER
) IS
BEGIN
  UPDATE studierende SET verguetung = verguetung * (1 + p_prozent / 100)
   WHERE matr_nr = p_id
  RETURNING verguetung INTO p_neu;
END erhoehe;
/`],
    ['Aufrufen', `EXEC verguetung_erhoehen(20);

DECLARE v NUMBER;
BEGIN
  erhoehe(3, 10, v);
  erhoehe(p_id => 3, p_neu => v);   -- benannte Parameter
END;
/`],
    ['Funktion', `CREATE OR REPLACE FUNCTION brutto (p_netto NUMBER) RETURN NUMBER IS
BEGIN
  RETURN ROUND(p_netto * 1.19, 2);
END;
/

SELECT brutto(100) FROM dual;`, 'Funktionen liefern immer einen Wert (RETURN) und sind in SQL nutzbar.'],
    ['Verwalten', `DROP PROCEDURE erhoehe;
DROP FUNCTION brutto;
DESC jahresverguetung
SELECT text FROM user_source WHERE name = 'BRUTTO' ORDER BY line;`],
  ]],
  ['Trigger', [
    ['Zeilen-Trigger', `CREATE OR REPLACE TRIGGER trg_kunde_bi
  BEFORE INSERT OR UPDATE ON kunde
  FOR EACH ROW
BEGIN
  :NEW.name := INITCAP(:NEW.name);
  IF INSERTING THEN
    :NEW.angelegt := SYSDATE;
  END IF;
END;
/`, ':NEW/:OLD nur mit FOR EACH ROW; :NEW ändern nur im BEFORE-Trigger.'],
    ['Audit-Trigger', `CREATE OR REPLACE TRIGGER trg_verguetung_audit
  AFTER UPDATE OF verguetung ON studierende
  FOR EACH ROW
  WHEN (NEW.verguetung <> OLD.verguetung)
BEGIN
  INSERT INTO verguetung_log VALUES (seq_verguetung_log.NEXTVAL, :OLD.matr_nr, :OLD.verguetung, :NEW.verguetung, SYSDATE);
END;
/`, 'Im WHEN steht NEW/OLD ohne Doppelpunkt.'],
    ['Statement-Trigger', `CREATE OR REPLACE TRIGGER trg_keine_loeschung
  BEFORE DELETE ON studiengang
BEGIN
  RAISE_APPLICATION_ERROR(-20100, 'Studiengänge dürfen nicht gelöscht werden');
END;
/`],
    ['Verwalten', `ALTER TRIGGER trg_kunde_bi DISABLE;
ALTER TRIGGER trg_kunde_bi ENABLE;
DROP TRIGGER trg_kunde_bi;`, 'ORA-04091 (mutating table): Ein Zeilen-Trigger darf seine eigene Tabelle nicht abfragen.'],
  ]],
  ['Packages', [
    ['Spezifikation & Body', `CREATE OR REPLACE PACKAGE kasse AS
  g_summe NUMBER := 0;
  PROCEDURE buchen (p_betrag NUMBER);
  FUNCTION summe RETURN NUMBER;
END kasse;
/
CREATE OR REPLACE PACKAGE BODY kasse AS
  PROCEDURE buchen (p_betrag NUMBER) IS
  BEGIN
    g_summe := g_summe + p_betrag;
  END;
  FUNCTION summe RETURN NUMBER IS
  BEGIN
    RETURN g_summe;
  END;
END kasse;
/
BEGIN
  kasse.buchen(10);
  DBMS_OUTPUT.PUT_LINE(kasse.summe);
END;
/`, 'Package-Variablen behalten ihren Wert für die Dauer der Session.'],
  ]],
  ['Collections & Records', [
    ['Typen', `DECLARE
  TYPE t_rec   IS RECORD (id NUMBER, name VARCHAR2(30));
  TYPE t_assoc IS TABLE OF VARCHAR2(30) INDEX BY PLS_INTEGER;
  TYPE t_liste IS TABLE OF NUMBER;
  TYPE t_feld  IS VARRAY(5) OF NUMBER;
  r t_rec;
  a t_assoc;
  l t_liste := t_liste(1, 2, 3);
BEGIN
  r.id := 1;  a(42) := 'x';
  l.EXTEND;  l(l.LAST) := 4;
END;
/`],
    ['Methoden', `x.COUNT  x.FIRST  x.LAST  x.NEXT(i)  x.PRIOR(i)
x.EXISTS(i)  x.EXTEND  x.EXTEND(n)  x.DELETE  x.DELETE(i)  x.TRIM`],
    ['BULK COLLECT & FORALL', `DECLARE
  TYPE t_ids IS TABLE OF studierende.matr_nr%TYPE;
  v_ids t_ids;
BEGIN
  SELECT matr_nr BULK COLLECT INTO v_ids FROM studierende WHERE sg_id = 20;
  FORALL i IN 1 .. v_ids.COUNT
    UPDATE studierende SET verguetung = verguetung + 100 WHERE matr_nr = v_ids(i);
END;
/`],
  ]],
  ['Dynamisches SQL', [
    ['EXECUTE IMMEDIATE', `DECLARE
  v_anz NUMBER;
BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLE temp_x (id NUMBER)';
  EXECUTE IMMEDIATE 'INSERT INTO temp_x VALUES (:1)' USING 42;
  EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM temp_x' INTO v_anz;
  DBMS_OUTPUT.PUT_LINE(v_anz);
END;
/`, 'Kein Semikolon am Ende der Zeichenkette.'],
  ]],
  ['Data Dictionary', [
    ['Wichtige Views', `SELECT * FROM user_tables;
SELECT * FROM user_tab_columns WHERE table_name = 'STUDIERENDE';
SELECT * FROM user_constraints;
SELECT * FROM user_views;
SELECT * FROM user_objects;
SELECT * FROM user_source WHERE name = 'JAHRESVERGUETUNG';
SELECT * FROM user_sequences;
SELECT * FROM user_triggers;
SELECT * FROM dictionary;`, 'Objektnamen stehen dort in GROSSBUCHSTABEN.'],
  ]],
  ['Häufige Fehler', [
    ['ORA-Codes', `ORA-00904  ungültiger Bezeichner – Tippfehler oder "Text" statt 'Text'
ORA-00942  Tabelle/View existiert nicht
ORA-00933  Anweisung falsch beendet – z. B. AS vor Tabellen-Alias, LIMIT
ORA-00936  Ausdruck fehlt
ORA-00937/00979  GROUP BY fehlt bzw. unvollständig
ORA-00001  UNIQUE/PRIMARY KEY verletzt
ORA-02291  Fremdschlüssel: Elterndatensatz fehlt
ORA-02292  Fremdschlüssel: Kinddatensätze vorhanden
ORA-01400  NULL in NOT-NULL-Spalte
ORA-01722  ungültige Zahl – oft + statt || beim Verketten
ORA-12899  Wert zu groß für Spalte
ORA-01403  NO_DATA_FOUND
ORA-01422  TOO_MANY_ROWS
ORA-06502  numerischer oder Wertefehler
ORA-04091  mutating table im Trigger
PLS-00103  Syntaxfehler (fehlendes ;, END IF, := …)
PLS-00201  Bezeichner nicht deklariert`],
  ]],
  ['Oracle vs. MySQL/MariaDB', [
    ['Unterschiede', `MySQL / MariaDB                Oracle
CONCAT(a, b, c) / 'a' + 'b'    a || b || c
LIMIT 10                       FETCH FIRST 10 ROWS ONLY
AUTO_INCREMENT                 GENERATED ... AS IDENTITY / SEQUENCE
IFNULL(a, b)                   NVL(a, b)
NOW()                          SYSDATE
"Text" oder 'Text'             nur 'Text'
SELECT 1;                      SELECT 1 FROM dual;
FROM kunde AS k                FROM kunde k
VARCHAR(50)                    VARCHAR2(50)
DELIMITER //                   Block mit / abschließen
'' ist leerer String           '' ist NULL`],
  ]],
];
