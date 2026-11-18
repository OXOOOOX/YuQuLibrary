-- New clients explicitly request question-driven full-episode retrieval.
-- Existing questions and their frozen contexts are not rewritten.
ALTER TABLE yuqu.chat_turns DROP CONSTRAINT chat_turns_scope_check;
ALTER TABLE yuqu.chat_turns ADD CONSTRAINT chat_turns_scope_check
  CHECK(scope IN ('near','until','all','selection','retrieval'));
