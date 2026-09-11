package com.weblens;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class WebLensApplication {

    public static void main(String[] args) {
        SpringApplication.run(WebLensApplication.class, args);
    }
}
