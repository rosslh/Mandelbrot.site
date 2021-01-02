#!/bin/bash
#Try to get rid of all the state that keeps us from compiling when bumping versions.
#Deleting each one of these has, at some point, been the key to getting things working again.

rm -rf Cargo.lock crate-wasm/pkg target/*
cargo build &

cd www
	rm -rf package-lock.json node_modules
	npm install &
cd ../

wait