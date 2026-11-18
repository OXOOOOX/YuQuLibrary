-- Stage 1: establish the application's namespace without connecting to other projects.
CREATE SCHEMA IF NOT EXISTS yuqu;
COMMENT ON SCHEMA yuqu IS 'YuQu Library application data';
