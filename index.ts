import express from "express";
import path from "path";

const app = express();
const port = process.env.PORT || 80;

app.use(express.static(path.join(__dirname, "static")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
