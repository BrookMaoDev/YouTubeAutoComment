require("dotenv").config();

import express from "express";
import session from "express-session";
import path from "path";
import url from "url";
import fs from "fs";
import { google } from "googleapis";
import { Pool } from "pg";

interface ChannelRow {
    id: string;
    handle: string;
    latest: string;
}

interface CommentRow {
    comment: string;
    user_id: string;
}

const app = express();
const port = process.env.PORT || 80;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URL = process.env.REDIRECT_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const isProduction = process.env.NODE_ENV === "production";

app.use(express.urlencoded({ extended: true })); // for form data
app.use(express.json()); // for JSON data (optional)

app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: isProduction, // Only send cookies over HTTPS in production
            httpOnly: true,
            sameSite: "lax",
        },
    })
);

const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URL
);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function gracefulshutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    await pool.end();
    console.log("Database connection closed");
    process.exit(0); // Exit the process cleanly
}

if (!isProduction) {
    // Listen for both SIGINT (Ctrl+C) and SIGTERM (Docker stop, etc.)
    process.on("SIGINT", gracefulshutdown); // Ctrl+C
    process.on("SIGTERM", gracefulshutdown); // Docker stop or kill
}

app.get("/", async (req, res) => {
    let q = url.parse(req.url, true).query;

    if (q.error) {
        // An error response e.g. error=access_denied
        console.log("Error:" + q.error);
    } else if (typeof q.code === "string") {
        // Get access and refresh tokens (if access_type is offline)
        let { tokens } = await oauth2Client.getToken(q.code);
        oauth2Client.setCredentials(tokens);

        const google_response = await fetch(
            `https://youtube.googleapis.com/youtube/v3/channels?part=id&part=snippet&mine=true&key=${CLIENT_ID}`,
            {
                headers: {
                    Authorization: `Bearer ${tokens.access_token}`,
                    Accept: "application / json",
                },
            }
        );

        if (!google_response.ok) {
            console.error(
                "Failed to fetch YouTube channel info:",
                await google_response.text()
            );
            res.sendFile(path.join(__dirname, "static", "index.html"));
            return;
        }

        const data = await google_response.json();
        const id = data.items[0].id;
        const username = data.items[0].snippet.title;
        const refresh_token = tokens.refresh_token;

        console.log(`refresh_token ${refresh_token}`);

        if (refresh_token !== undefined) {
            const query = `
          INSERT INTO app.users (id, username, refresh_token)
          VALUES ($1, $2, $3)
          ON CONFLICT (id)
          DO UPDATE SET username = EXCLUDED.username, refresh_token = EXCLUDED.refresh_token
        `;
            const db_result = await pool.query(query, [
                id,
                username,
                refresh_token,
            ]);
        }

        req.session.user = {
            id: id,
            username: username,
        };

        res.sendFile(path.join(__dirname, "static", "create.html"));
    } else {
        const filePath = path.join(__dirname, "static", "index.html");

        fs.readFile(filePath, "utf8", (err, html) => {
            if (err) return res.status(500).send("Error loading HTML");

            if (!CLIENT_ID || !REDIRECT_URL) {
                throw new Error(
                    "Missing environment variables: CLIENT_ID or REDIRECT_URL"
                );
            }

            const replacedHtml = html
                .replace(/%%GOOGLE_CLIENT_ID%%/g, CLIENT_ID)
                .replace(/%%GOOGLE_REDIRECT_URI%%/g, REDIRECT_URL);

            res.send(replacedHtml);
        });
    }
});

app.post("/create", async (req, res) => {
    if (!req.session.user) {
        res.redirect("/index.html");
        return;
    }

    const google_response = await fetch(
        `https://youtube.googleapis.com/youtube/v3/channels?part=id&forHandle=${req.body.channel}&key=${YOUTUBE_API_KEY}`,
        {
            headers: {
                Accept: "application / json",
            },
        }
    );

    if (!google_response.ok) {
        console.error(
            "Failed to fetch YouTube channel info:",
            await google_response.text()
        );
        res.redirect("/create.html?error=invalid_channel");
        return;
    }

    const data = await google_response.json();

    if (data.pageInfo.totalResults == 0) {
        res.redirect("/create.html?error=invalid_channel");
        return;
    }

    const id = data.items[0].id;

    const latest_video_response = await fetch(
        `https://youtube.googleapis.com/youtube/v3/search?part=snippet&channelId=${id}&key=${YOUTUBE_API_KEY}&type=video&maxResults=1&order=date`,
        {
            headers: {
                Accept: "application / json",
            },
        }
    );

    if (!latest_video_response.ok) {
        console.error(
            "Failed to fetch latest videos:",
            await latest_video_response.text()
        );
        res.redirect("/create.html");
        return;
    }

    const latest_video_data = await latest_video_response.json();

    let latest_video_id = "";
    if (latest_video_data.pageInfo.totalResults !== 0) {
        latest_video_id = latest_video_data.items[0].id.videoId;
    }

    const insertChannelQuery = `
  INSERT INTO app.channels (id, handle, latest)
  VALUES ($1, $2, $3)
  ON CONFLICT (id) DO NOTHING
`;

    let db_result = await pool.query(insertChannelQuery, [
        id,
        req.body.channel,
        latest_video_id,
    ]);

    const insertCommentQuery = `
  INSERT INTO app.comments (comment, user_id, channel_id)
  VALUES ($1, $2, $3)
`;

    db_result = await pool.query(insertCommentQuery, [
        req.body.comment,
        req.session.user.id,
        id,
    ]);

    const filePath = path.join(__dirname, "static", "confirmation.html");

    fs.readFile(filePath, "utf8", (err, html) => {
        if (err) return res.status(500).send("Error loading HTML");

        const replacedHtml = html.replace(
            /%%CHANNEL_NAME%%/g,
            req.body.channel
        );

        res.send(replacedHtml);
    });
});

app.post("/poll", async (req, res) => {
    const channels = await pool.query(`SELECT DISTINCT * FROM app.channels`);
    const tasks = [];

    for (const row of channels.rows as ChannelRow[]) {
        const latest_video_response = await fetch(
            `https://youtube.googleapis.com/youtube/v3/search?part=snippet&channelId=${row.id}&key=${YOUTUBE_API_KEY}&type=video&maxResults=1&order=date`,
            {
                headers: {
                    Accept: "application / json",
                },
            }
        );

        if (!latest_video_response.ok) {
            console.error(
                "Failed to fetch latest videos:",
                await latest_video_response.text()
            );
            return;
        }

        const latest_video_data = await latest_video_response.json();

        let latest_video_id = "";
        if (latest_video_data.pageInfo.totalResults !== 0) {
            latest_video_id = latest_video_data.items[0].id.videoId;
        }

        if (latest_video_id != row.latest) {
            tasks.push({
                channel_id: row.id,
                video_id: latest_video_id,
                comments: {} as { [key: string]: string[] },
            });

            const update_result = await pool.query(
                `UPDATE app.channels SET latest = '${latest_video_id}' WHERE id = '${row.id}'`
            );
        }
    }

    for (const task of tasks) {
        const comments = await pool.query(
            `DELETE FROM app.comments
             WHERE channel_id = '${task.channel_id}'
             RETURNING comment, user_id`
        );

        for (const comment of comments.rows as CommentRow[]) {
            if (!(comment.user_id in task.comments)) {
                task.comments[comment.user_id] = [];
            }

            task.comments[comment.user_id].push(comment.comment);
        }
    }

    console.log("\n📋 Tasks to process:");
    console.dir(tasks, { depth: null });
    console.log();

    const users = {} as { [key: string]: string };

    for (const task of tasks) {
        for (const user_id in task.comments) {
            if (!(user_id in users)) {
                const user_data = await pool.query(
                    `SELECT refresh_token FROM app.users WHERE id = '${user_id}'`
                );

                const refresh_token = user_data.rows[0].refresh_token;

                const response = await fetch(
                    "https://oauth2.googleapis.com/token",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded",
                        },
                        body: new URLSearchParams({
                            client_id: CLIENT_ID || "",
                            client_secret: CLIENT_SECRET || "",
                            refresh_token: String(refresh_token),
                            grant_type: "refresh_token",
                        }),
                    }
                );

                if (!response.ok) {
                    console.error(
                        "Failed to refresh access token:",
                        await response.text()
                    );
                    return;
                }

                const data = await response.json();
                const access_token = data.access_token;

                users[user_id] = access_token;
            }

            for (const comment of task.comments[user_id]) {
                const commentResponse = await fetch(
                    "https://youtube.googleapis.com/youtube/v3/commentThreads?part=snippet",
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${users[user_id]}`,
                            Accept: "application/json",
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                            snippet: {
                                channelId: task.channel_id,
                                videoId: task.video_id,
                                topLevelComment: {
                                    snippet: {
                                        textOriginal: comment,
                                    },
                                },
                            },
                        }),
                    }
                );

                if (!commentResponse.ok) {
                    console.error(
                        `Failed to post comment "${comment}" on video ${task.video_id}:`,
                        await commentResponse.text()
                    );
                } else {
                    console.log(
                        `Comment "${comment}" posted successfully on video ${task.video_id}!`
                    );
                }
            }
        }
    }

    console.log("\n✅ Finished posting all comments.\n");
    res.sendStatus(200);
});

app.use(express.static(path.join(__dirname, "static")));

app.listen(port, async () => {
    console.log(`App listening on port ${port}`);
});
