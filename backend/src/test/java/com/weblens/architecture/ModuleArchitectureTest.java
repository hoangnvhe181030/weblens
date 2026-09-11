package com.weblens.architecture;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

@AnalyzeClasses(packages = "com.weblens")
class ModuleArchitectureTest {

    @ArchTest
    static final ArchRule CONTROLLERS_DO_NOT_BYPASS_SERVICES = noClasses()
            .that().resideInAPackage("..controller..")
            .should().dependOnClassesThat().resideInAPackage("..repository..");

    @ArchTest
    static final ArchRule DOMAIN_MODELS_STAY_INDEPENDENT = noClasses()
            .that().resideInAPackage("..model..")
            .should().dependOnClassesThat().resideInAnyPackage(
                    "..controller..",
                    "..dto..",
                    "..entity..",
                    "..repository..",
                    "org.springframework.."
            );
}
