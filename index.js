function parseLogLine(line) {
    // TEMPORARY: Print every single console line so we can see how Bedrock formats deaths
    console.log("CON: " + line);

    // Look for Bedrock death patterns 
    if (line.includes("slain") || line.includes("shot") || line.includes("died") || line.includes("by")) {
        console.log(`Potential death captured: ${line}`);
        
        const parts = line.trim().split(" ");
        const victim = parts[0];
        let killer = "Environment";
        let weapon = "Unknown";

        if (line.includes("slain by") || line.includes("shot by")) {
            killer = parts[parts.length - 1];
            weapon = line.includes("shot by") ? "Projectile" : "Melee";
        }

        sendKillToWorker({ killer, victim, weapon });
    }
}
