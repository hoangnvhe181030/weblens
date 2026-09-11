package com.weblens.messaging;

public record InboxRecord(byte[] payloadSha256, String outcome) {
    public InboxRecord {
        payloadSha256 = payloadSha256.clone();
    }

    @Override
    public byte[] payloadSha256() {
        return payloadSha256.clone();
    }
}
