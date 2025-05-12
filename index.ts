#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import express from "express";

const execFileAsync = promisify(execFile);

async function ensureDateDirectory(): Promise<string> {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");

    const downloadDir = join(homedir(), "Downloads");
    const dateDir = join(downloadDir, `${year}${month}${day}`);

    await mkdir(dateDir, { recursive: true });
    return dateDir;
}

async function takeScreenshot(windowName?: string, shouldSwitchWindow: boolean = false): Promise<string> {
    const dateDir = await ensureDateDirectory();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const windowSuffix = windowName ? `-${windowName.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
    const filename = `screenshot${windowSuffix}-${timestamp}.png`;
    const filepath = join(dateDir, filename);

    try {
        if (windowName && shouldSwitchWindow) {
            // Simple activate and fullscreen
            const script = `
                tell application "${windowName}"
                    activate
                end tell
                
                delay 1
                
                tell application "System Events"
                    keystroke "f" using {command down, control down}
                end tell
                
                delay 2
            `;
            
            await execFileAsync("osascript", ["-e", script]);
            console.error(`Debug: Activated and made ${windowName} fullscreen`);
        }

        // Take the screenshot
        await execFileAsync("screencapture", [filepath]);
        console.error(`Debug: Screenshot taken`);
        
        if (windowName && shouldSwitchWindow) {
            // Just exit fullscreen, no minimizing
            const postCaptureScript = `
                tell application "System Events"
                    keystroke "f" using {command down, control down}
                end tell
            `;
            
            await execFileAsync("osascript", ["-e", postCaptureScript]);
            console.error(`Debug: Exited fullscreen mode for ${windowName}`);
        }
        
        return filepath;
    } catch (error) {
        console.error(`Screenshot error details:`, error);
        throw new Error(`Screenshot capture failed: ${error}`);
    }
}

// Function to convert image file to raw base64 (without prefix)
async function imageToBase64(filepath: string): Promise<string> {
    try {
        const imageBuffer = await readFile(filepath);
        return imageBuffer.toString('base64');
    } catch (error) {
        console.error(`Error converting image to base64:`, error);
        throw new Error(`Failed to convert image to base64: ${error}`);
    }
}

// HTTP Server Setup with Express
const app = express();
app.use(express.json());

app.post("/invoke", async (req: express.Request, res: express.Response) => {
    try {
        const { method, params } = req.body;
        if (method === "callTool" && params?.name === "capture") {
            const { arguments: args } = params;
            const region = args?.region || "full";
            const format = args?.format || "markdown";
            const windowName = args?.windowName;
            const switchToWindow = args?.switchToWindow || false;
            const includeBase64 = args?.includeBase64 !== false; // Default to true

            if (region !== "full") {
                return res.status(400).json({ error: "Only 'full' region is supported" });
            }

            console.error(
                `Debug: Starting screenshot capture for region: ${region}, format: ${format}, window: ${windowName || 'current'}`,
            );
            
            const imagePath = await takeScreenshot(windowName, switchToWindow);
            console.error(`Debug: Screenshot saved to: ${imagePath}`);
            
            // Convert image to base64
            let base64Image = "";
            if (includeBase64) {
                base64Image = await imageToBase64(imagePath);
                console.error(`Debug: Image converted to base64`);
            }
            
            // Determine the response format
            if (includeBase64) {
                res.json({
                    content: [
                        {
                            type: "text",
                            text: `Screenshot saved to: ${imagePath}`,
                        },
                        {
                            type: "base64_image",
                            data: base64Image  // Just the raw base64 data, no prefix
                        }
                    ],
                });
            } else {
                res.json({
                    content: [
                        {
                            type: "text",
                            text: `Screenshot saved to: ${imagePath}`,
                        }
                    ],
                });
            }
        } else if (method === "listTools") {
            res.json({
                tools: [
                    {
                        name: "capture",
                        description:
                            "Captures a screenshot and returns a raw base64-encoded image. " +
                            "Options:\n" +
                            "- region: 'full' (only full supported)\n" +
                            "- format: 'markdown' (default)\n" +
                            "- windowName: Optional name of window to focus\n" +
                            "- switchToWindow: Whether to switch to the specified window (default: false)\n" +
                            "- includeBase64: Whether to include base64 image data in response (default: true)\n" +
                            "The screenshot is saved to a dated directory in Downloads and returned as raw base64 data.",
                    },
                ],
            });
        } else {
            res.status(400).json({ error: "Unsupported method or tool" });
        }
    } catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

// Start HTTP server
const PORT = 8000;
app.listen(PORT, () => {
    console.log(`Screenshot MCP server running on port ${PORT}`);
    console.log(`Access URLs:`);
    console.log(`- http://localhost:${PORT}`);
    
    try {
        // Get all network interfaces
        const nets = networkInterfaces();
        for (const name of Object.keys(nets)) {
            const interfaces = nets[name];
            if (!interfaces) continue;
            
            for (const net of interfaces) {
                // Skip internal and non-IPv4 addresses
                if (!net.internal && net.family === 'IPv4') {
                    console.log(`- http://${net.address}:${PORT}`);
                }
            }
        }
    } catch (err) {
        console.error("Error listing network interfaces:", err);
    }
    
    console.log(`\nTo test, use:`);
    console.log(`curl -X POST http://localhost:${PORT}/invoke -H "Content-Type: application/json" -d '{"method": "callTool", "params": {"name": "capture", "arguments": {"region": "full", "windowName": "Calendar", "switchToWindow": true}}}'`);
});