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

async function takeScreenshot(windowName?: string, shouldSwitchWindow: boolean = false, switchToSubwindow: boolean = false, subwindowKey: string = ""): Promise<string> {
    const dateDir = await ensureDateDirectory();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const windowSuffix = windowName ? `-${windowName.replace(/[^a-zA-Z0-9]/g, "_")}` : "";
    const filename = `screenshot${windowSuffix}-${timestamp}.png`;
    const filepath = join(dateDir, filename);

    try {
        if (windowName && shouldSwitchWindow) {
            let script = `
                tell application "${windowName}"
                    activate
                end tell
                
                delay 1
            `;

            if (switchToSubwindow && subwindowKey) {
                script += `
                    tell application "System Events"
                        keystroke "${subwindowKey}" using {command down}
                    end tell
                    
                    delay 2
                `;
            }

            script += `
                tell application "System Events"
                    keystroke "f" using {command down, control down}
                end tell
                
                delay 2
            `;
            
            await execFileAsync("osascript", ["-e", script]);
            console.error(`Debug: Activated ${windowName}${switchToSubwindow && subwindowKey ? `, switched to subwindow with Cmd+${subwindowKey},` : ""} and made fullscreen`);
        }

        await execFileAsync("screencapture", [filepath]);
        console.error(`Debug: Screenshot taken`);
        
        if (windowName && shouldSwitchWindow) {
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

async function imageToBase64(filepath: string): Promise<string> {
    try {
        const imageBuffer = await readFile(filepath);
        return imageBuffer.toString('base64');
    } catch (error) {
        console.error(`Error converting image to base64:`, error);
        throw new Error(`Failed to convert image to base64: ${error}`);
    }
}

const app = express();
app.use(express.json());

app.post("/invoke", async (req: express.Request, res: express.Response) => {
    try {
        const { method, params } = req.body;

        // Extract name and arguments, supporting both {params: {name, arguments}} and {params: {data: {name, arguments}}}
        const toolData = params?.data || params; // Use params.data if it exists, otherwise use params directly
        const toolName = toolData?.name;
        const args = toolData?.arguments;

        if (method === "callTool" && toolName === "capture") {
            const region = args?.region || "full";
            const format = args?.format || "markdown";
            const windowName = args?.windowName;
            const switchToWindow = args?.switchToWindow || false;
            const switchToSubwindow = args?.switchToSubwindow || false;
            const subwindowKey = args?.subwindowKey || "";
            const includeBase64 = args?.includeBase64 !== false;

            if (region !== "full") {
                return res.status(400).json({ error: "Only 'full' region is supported" });
            }

            console.error(
                `Debug: Starting screenshot capture for region: ${region}, format: ${format}, window: ${windowName || 'current'}, switchToSubwindow: ${switchToSubwindow}, subwindowKey: ${subwindowKey || 'none'}`,
            );
            
            const imagePath = await takeScreenshot(windowName, switchToWindow, switchToSubwindow, subwindowKey);
            console.error(`Debug: Screenshot saved to: ${imagePath}`);
            
            let base64Image = "";
            if (includeBase64) {
                base64Image = await imageToBase64(imagePath);
                console.error(`Debug: Image converted to base64`);
            }
            
            if (includeBase64) {
                res.json({
                    content: [
                        {
                            type: "text",
                            text: `Screenshot saved to: ${imagePath}`,
                        },
                        {
                            type: "base64_image",
                            data: base64Image
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
                            "- switchToSubwindow: Whether to switch to a subwindow (e.g., a specific view in the app) (default: false)\n" +
                            "- subwindowKey: The key to press with Cmd to switch to the subwindow (e.g., '2' for Cmd+2 in Outlook to switch to calendar view) (default: none)\n" +
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

const PORT = 8000;
app.listen(PORT, () => {
    console.log(`Screenshot MCP server running on port ${PORT}`);
    console.log(`Access URLs:`);
    console.log(`- http://localhost:${PORT}`);
    
    try {
        const nets = networkInterfaces();
        for (const name of Object.keys(nets)) {
            const interfaces = nets[name];
            if (!interfaces) continue;
            
            for (const net of interfaces) {
                if (!net.internal && net.family === 'IPv4') {
                    console.log(`- http://${net.address}:${PORT}`);
                }
            }
        }
    } catch (err) {
        console.error("Error listing network interfaces:", err);
    }
    
    console.log(`\nTo test, use:`);
    console.log(`curl -X POST http://localhost:${PORT}/invoke -H "Content-Type: application/json" -d '{"method": "callTool", "params": {"name": "capture", "arguments": {"region": "full", "windowName": "Microsoft Outlook", "switchToWindow": true, "switchToSubwindow": true, "subwindowKey": "2"}}}'`);
});