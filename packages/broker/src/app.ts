import express, { Express } from "express";
import { oauthRouter } from "./oauth.js";

export const app: Express = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/", oauthRouter);
