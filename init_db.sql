CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.users (
    id VARCHAR(256) PRIMARY KEY,
    username VARCHAR(256) NOT NULL,
    refresh_token VARCHAR(256) NOT NULL
);

CREATE TABLE app.channels (
    id VARCHAR(256) PRIMARY KEY,
    handle VARCHAR(256) NOT NULL,
    latest VARCHAR(256) NOT NULL
);

CREATE TABLE app.comments (
    comment TEXT NOT NULL,
    user_id VARCHAR(256) NOT NULL,
    channel_id VARCHAR(256) NOT NULL,
    CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES app.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_channel FOREIGN KEY (channel_id) REFERENCES app.channels(id) ON UPDATE CASCADE ON DELETE CASCADE
);



