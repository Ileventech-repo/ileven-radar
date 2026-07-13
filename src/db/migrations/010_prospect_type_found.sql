-- Allow 'found' prospect type (businesses with a working website)
ALTER TABLE prospects
  DROP CONSTRAINT IF EXISTS prospects_prospect_type_check;

ALTER TABLE prospects
  ADD CONSTRAINT prospects_prospect_type_check
  CHECK (prospect_type IN ('no_website', 'bad_website', 'found'));
