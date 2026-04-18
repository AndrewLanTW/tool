#!/bin/bash

echo "========================================"
echo "  XiaoHongShu Tool - Starting..."
echo "========================================"

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Check if node exists
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found! Please install Node.js first."
    echo "Download: https://nodejs.org/"
    read -p "Press Enter to exit..."
    exit 1
fi

# Install dependencies if node_modules not exists
if [ ! -d "node_modules" ]; then
    echo "[INFO] Installing dependencies... Please wait..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] Installation failed! Please check network connection."
        read -p "Press Enter to exit..."
        exit 1
    fi
fi

# Start server
echo "[INFO] Starting server..."
sleep 2 && open http://localhost:7788/ &
node server.js

read -p "Press Enter to exit..."
