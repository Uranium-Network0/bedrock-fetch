import time
import re
import requests

# Replace with your actual Cloudflare Worker URL
WORKER_URL = "https://your-worker.your-subdomain.workers.dev"
LOG_FILE_PATH = "latest.log"

def tail_and_send():
    pattern = re.compile(r"\b(death|die|died)\b", re.IGNORECASE)
    
    with open(LOG_FILE_PATH, "r") as f:
        # Move to the end of the file to read only new incoming logs
        f.seek(0, 2)
        
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.5)
                continue
                
            stripped_line = line.strip()
            if pattern.search(stripped_line):
                try:
                    payload = {"logLine": stripped_line}
                    response = requests.post(WORKER_URL, json=payload, timeout=5)
                    print(f"Sent: {stripped_line} | Status: {response.status_code}")
                except Exception as e:
                    print(f"Failed to send log: {e}")

if __name__ == "__main__":
    tail_and_send()
