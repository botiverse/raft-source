-- Retired Wiki: the drop moved to 0610-0614 before this reached production. As one
-- transaction it locked servers, channels, agents and users together (ACCESS EXCLUSIVE
-- on each, for their foreign keys), the 0561 pattern: a deadlock risk on the busiest
-- tables (#botiverse-raft-deployment:a0c0c721). 0610-0613 drop the foreign keys one hot
-- table at a time, 0614 the tables. Staging already ran the first version; 0610-0614
-- are no-ops there.
SELECT 1;
