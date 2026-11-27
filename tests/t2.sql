CREATE TABLE abteilung (
  abt_id NUMBER(4) CONSTRAINT pk_abteilung PRIMARY KEY,
  name   VARCHAR2(30) NOT NULL,
  ort    VARCHAR2(30)
);
CREATE TABLE mitarbeiter (
  ma_id    NUMBER(6) CONSTRAINT pk_mitarbeiter PRIMARY KEY,
  vorname  VARCHAR2(30),
  nachname VARCHAR2(30) NOT NULL,
  job      VARCHAR2(20),
  gehalt   NUMBER(8,2) CONSTRAINT ck_gehalt CHECK (gehalt > 0),
  eintritt DATE DEFAULT SYSDATE,
  chef_id  NUMBER(6) CONSTRAINT fk_ma_chef REFERENCES mitarbeiter(ma_id),
  abt_id   NUMBER(4) CONSTRAINT fk_ma_abt REFERENCES abteilung(abt_id) ON DELETE SET NULL
);
INSERT INTO abteilung VALUES (10, 'Vertrieb', 'München');
INSERT INTO abteilung VALUES (20, 'IT', 'Leipzig');
INSERT INTO abteilung VALUES (30, 'Personal', 'Köln');
INSERT INTO abteilung VALUES (40, 'Einkauf', NULL);
INSERT INTO mitarbeiter VALUES (1, 'Anna', 'Berg', 'CHEF', 9500, DATE '2015-04-01', NULL, 10);
INSERT INTO mitarbeiter VALUES (2, 'Ben', 'Claus', 'LEITUNG', 6200, DATE '2018-02-15', 1, 20);
INSERT INTO mitarbeiter VALUES (3, 'Clara', 'Dahl', 'ENTWICKLUNG', 5100, DATE '2020-09-01', 2, 20);
INSERT INTO mitarbeiter VALUES (4, 'Dora', 'Eck', 'ENTWICKLUNG', 4800, DATE '2022-01-10', 2, 20);
INSERT INTO mitarbeiter VALUES (5, 'Eva', 'Fuchs', 'VERTRIEB', 4300, DATE '2019-06-01', 1, 10);
INSERT INTO mitarbeiter VALUES (6, 'Finn', 'Graf', 'VERTRIEB', 3900, DATE '2023-03-01', 5, 10);
INSERT INTO mitarbeiter VALUES (7, 'Greta', 'Hahn', 'PERSONAL', 4100, DATE '2021-11-15', 1, 30);
INSERT INTO mitarbeiter VALUES (8, 'Hugo', 'Ilg', 'AZUBI', 1200, DATE '2025-08-01', 3, NULL);
COMMIT;
SELECT a.name, COUNT(m.ma_id) anz, ROUND(AVG(m.gehalt),2) schnitt FROM abteilung a LEFT JOIN mitarbeiter m ON m.abt_id = a.abt_id GROUP BY a.name HAVING COUNT(m.ma_id) >= 0 ORDER BY anz DESC, a.name;
SELECT m.nachname, c.nachname AS chef FROM mitarbeiter m, mitarbeiter c WHERE m.chef_id = c.ma_id(+) ORDER BY m.ma_id;
SELECT LPAD(' ', 2*(LEVEL-1)) || nachname AS baum, LEVEL, SYS_CONNECT_BY_PATH(nachname, '/') pfad FROM mitarbeiter START WITH chef_id IS NULL CONNECT BY PRIOR ma_id = chef_id ORDER SIBLINGS BY nachname;
SELECT nachname, gehalt FROM mitarbeiter WHERE gehalt > (SELECT AVG(gehalt) FROM mitarbeiter) ORDER BY 2 DESC;
SELECT nachname FROM mitarbeiter m WHERE EXISTS (SELECT 1 FROM mitarbeiter x WHERE x.chef_id = m.ma_id);
SELECT job, LISTAGG(vorname, ', ') WITHIN GROUP (ORDER BY vorname) namen FROM mitarbeiter GROUP BY job ORDER BY job;
SELECT * FROM (SELECT nachname, gehalt, ROW_NUMBER() OVER (PARTITION BY abt_id ORDER BY gehalt DESC) rn, abt_id FROM mitarbeiter) WHERE rn = 1;
SELECT nachname FROM mitarbeiter WHERE ROWNUM <= 2;
SELECT abt_id FROM abteilung MINUS SELECT abt_id FROM mitarbeiter;
SELECT name, ort, NVL(ort, 'unbekannt'), DECODE(abt_id, 10, 'zehn', 20, 'zwanzig', 'sonst') d, CASE WHEN abt_id > 20 THEN 'groß' ELSE 'klein' END k FROM abteilung;
SELECT d.name, e.nachname FROM abteilung d JOIN mitarbeiter e USING (abt_id) WHERE abt_id = 20;
SELECT job, abt_id, SUM(gehalt) FROM mitarbeiter GROUP BY ROLLUP(abt_id, job) ORDER BY abt_id, job;
WITH t AS (SELECT abt_id, MAX(gehalt) mx FROM mitarbeiter GROUP BY abt_id) SELECT m.nachname, t.mx FROM mitarbeiter m JOIN t ON t.abt_id = m.abt_id AND t.mx = m.gehalt;
SELECT EXTRACT(YEAR FROM eintritt) j, MONTHS_BETWEEN(DATE '2026-11-26', eintritt) mb, ADD_MONTHS(eintritt, 1) am, TRUNC(SYSDATE) - TRUNC(SYSDATE) z FROM mitarbeiter WHERE ma_id = 1;
UPDATE mitarbeiter SET gehalt = -5 WHERE ma_id = 1;
DELETE FROM abteilung WHERE abt_id = 10;
SELECT ma_id, abt_id FROM mitarbeiter WHERE abt_id IS NULL;
ROLLBACK;
SELECT COUNT(*) FROM abteilung;
DELETE FROM mitarbeiter WHERE ma_id = 1;
INSERT INTO mitarbeiter (ma_id, nachname, abt_id) VALUES (99, 'X', 77);
SELECT nachname, eintritt FROM mitarbeiter WHERE ma_id = 3 FOR UPDATE;
