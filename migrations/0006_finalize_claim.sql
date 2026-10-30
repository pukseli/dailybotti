-- Lets only one request post a day's podium, like board_claim_until does for the board. NULL means unclaimed.
ALTER TABLE days ADD COLUMN finalize_claim_until TEXT;
