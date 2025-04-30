require("dotenv").config();

import express from "express";
import jwt from "jsonwebtoken";
import path from "path";
import url from "url";
import fs from "fs";
import { google } from "googleapis";
import { Pool } from "pg";
import cookieParser from "cookie-parser";

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
const DATABASE_URL = process.env.DATABASE_URL;

const isProduction = process.env.NODE_ENV === "production";

// Ensure all necessary environment variables are set
if (
    !CLIENT_ID ||
    !CLIENT_SECRET ||
    !REDIRECT_URL ||
    !SESSION_SECRET ||
    !YOUTUBE_API_KEY ||
    !DATABASE_URL
) {
    throw new Error("Missing required environment variables");
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URL
);

const pool = new Pool({
    connectionString: DATABASE_URL,
});

async function gracefulshutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    await pool.end();
    console.log("Database connection closed");
    process.exit(0);
}

if (!isProduction) {
    process.on("SIGINT", gracefulshutdown);
    process.on("SIGTERM", gracefulshutdown);
}

app.get("/", async (req, res) => {
    let q = url.parse(req.url, true).query;

    if (q.error) {
        console.log("Error:" + q.error);
    } else if (typeof q.code === "string") {
        let { tokens } = await oauth2Client.getToken(q.code);
        oauth2Client.setCredentials(tokens);

        const googleResponse = await fetch(
            `https://youtube.googleapis.com/youtube/v3/channels?part=id&part=snippet&mine=true&key=${YOUTUBE_API_KEY}`,
            {
                headers: {
                    Authorization: `Bearer ${tokens.access_token}`,
                    Accept: "application/json",
                },
            }
        );

        if (!googleResponse.ok) {
            console.error(
                "Failed to fetch YouTube channel info:",
                await googleResponse.text()
            );
            res.sendFile(path.join(__dirname, "static", "index.html"));
            return;
        }

        const data = await googleResponse.json();
        const channelId = data.items[0].id;
        const username = data.items[0].snippet.title;
        const refreshToken = tokens.refresh_token;

        const token = jwt.sign(
            { id: channelId, name: username },
            SESSION_SECRET,
            { expiresIn: "7d" }
        );

        res.cookie("token", token, {
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax",
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        if (refreshToken !== undefined) {
            const query = `
                INSERT INTO app.users (id, username, refresh_token)
                VALUES ($1, $2, $3)
                ON CONFLICT (id)
                DO UPDATE SET username = EXCLUDED.username, refresh_token = EXCLUDED.refresh_token
            `;
            await pool.query(query, [channelId, username, refreshToken]);
        }

        res.sendFile(path.join(__dirname, "static", "create.html"));
    } else {
        const filePath = path.join(__dirname, "static", "index.html");

        fs.readFile(filePath, "utf8", (err, html) => {
            if (err) return res.status(500).send("Error loading HTML");

            const replacedHtml = html
                .replace(/%%GOOGLE_CLIENT_ID%%/g, CLIENT_ID)
                .replace(/%%GOOGLE_REDIRECT_URI%%/g, REDIRECT_URL);

            res.send(replacedHtml);
        });
    }
});

app.post("/create", async (req, res) => {
    const token = req.cookies.token;
    if (!token) {
        res.redirect("/index.html");
        return;
    }

    let decoded: { id: string; name: string };
    try {
        decoded = jwt.verify(token, SESSION_SECRET) as {
            id: string;
            name: string;
        };
    } catch (err) {
        console.error("Invalid token:", err);
        res.redirect("/index.html");
        return;
    }

    const googleResponse = await fetch(
        `https://youtube.googleapis.com/youtube/v3/channels?part=id&forHandle=${req.body.channel}&key=${YOUTUBE_API_KEY}`,
        {
            headers: {
                Accept: "application/json",
            },
        }
    );

    if (!googleResponse.ok) {
        console.error(
            "Failed to fetch YouTube channel info:",
            await googleResponse.text()
        );
        res.redirect("/create.html?error=invalid_channel");
        return;
    }

    const data = await googleResponse.json();

    if (data.pageInfo.totalResults === 0) {
        res.redirect("/create.html?error=invalid_channel");
        return;
    }

    const channelId = data.items[0].id;

    const latestVideoResponse = await fetch(
        `https://youtube.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&key=${YOUTUBE_API_KEY}&type=video&maxResults=1&order=date`,
        {
            headers: {
                Accept: "application/json",
            },
        }
    );

    if (!latestVideoResponse.ok) {
        console.error(
            "Failed to fetch latest videos:",
            await latestVideoResponse.text()
        );
        res.redirect("/create.html");
        return;
    }

    const latestVideoData = await latestVideoResponse.json();
    let latestVideoId = "";
    if (latestVideoData.pageInfo.totalResults !== 0) {
        latestVideoId = latestVideoData.items[0].id.videoId;
    }

    const insertChannelQuery = `
        INSERT INTO app.channels (id, handle, latest)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
    `;

    await pool.query(insertChannelQuery, [
        channelId,
        req.body.channel,
        latestVideoId,
    ]);

    const insertCommentQuery = `
        INSERT INTO app.comments (comment, user_id, channel_id)
        VALUES ($1, $2, $3)
    `;

    await pool.query(insertCommentQuery, [
        req.body.comment,
        decoded.id,
        channelId,
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
        const latestVideoResponse = await fetch(
            `https://youtube.googleapis.com/youtube/v3/search?part=snippet&channelId=${row.id}&key=${YOUTUBE_API_KEY}&type=video&maxResults=1&order=date`,
            {
                headers: {
                    Accept: "application/json",
                },
            }
        );

        if (!latestVideoResponse.ok) {
            console.error(
                "Failed to fetch latest videos:",
                await latestVideoResponse.text()
            );
            return;
        }

        const latestVideoData = await latestVideoResponse.json();
        let latestVideoId = "";
        if (latestVideoData.pageInfo.totalResults !== 0) {
            latestVideoId = latestVideoData.items[0].id.videoId;
        }

        if (latestVideoId !== row.latest) {
            tasks.push({
                channel_id: row.id,
                video_id: latestVideoId,
                comments: {} as { [key: string]: string[] },
            });

            await pool.query(
                `UPDATE app.channels SET latest = $1 WHERE id = $2`,
                [latestVideoId, row.id]
            );
        }
    }

    for (const task of tasks) {
        const comments = await pool.query(
            `DELETE FROM app.comments WHERE channel_id = $1 RETURNING comment, user_id`,
            [task.channel_id]
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
                const userData = await pool.query(
                    `SELECT refresh_token FROM app.users WHERE id = $1`,
                    [user_id]
                );

                const refreshToken = userData.rows[0].refresh_token;

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
                            refresh_token: String(refreshToken),
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
                const accessToken = data.access_token;

                users[user_id] = accessToken;
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
                        "Failed to post comment:",
                        await commentResponse.text()
                    );
                    return;
                }

                console.log(
                    `Comment "${comment}" posted successfully on channel ${task.channel_id}, video ${task.video_id}!`
                );
            }
        }
    }

    res.json({ status: "complete" });
});

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});
