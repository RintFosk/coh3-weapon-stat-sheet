#!/bin/sh
set -e

mkdir -p dist
cp index.html styles.css viewer.js dist/
cp -r data/weapon-history dist/data/weapon-history
