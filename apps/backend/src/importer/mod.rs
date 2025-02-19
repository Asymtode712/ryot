use std::sync::Arc;

use apalis::prelude::Storage;
use async_graphql::{Context, Enum, InputObject, Object, Result, SimpleObject};
use chrono::{Duration, Utc};
use database::{ImportSource, MetadataLot};
use itertools::Itertools;
use rust_decimal_macros::dec;
use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, EntityTrait, FromJsonQueryResult, QueryFilter,
    QueryOrder,
};
use serde::{Deserialize, Serialize};
use tracing::instrument;

use crate::{
    background::ApplicationJob,
    entities::{import_report, prelude::ImportReport, user::UserWithOnlyPreferences},
    fitness::resolver::ExerciseService,
    miscellaneous::resolver::MiscellaneousService,
    models::{
        fitness::UserWorkoutInput,
        media::{
            ChangeCollectionToEntityInput, CreateOrUpdateCollectionInput,
            ImportOrExportItemIdentifier, ImportOrExportMediaItem, PostReviewInput,
            ProgressUpdateInput,
        },
        EntityLot,
    },
    traits::AuthProvider,
    users::UserReviewScale,
    utils::partial_user_by_id,
};

mod goodreads;
mod mal;
mod media_json;
mod media_tracker;
mod movary;
mod story_graph;
mod strong_app;
mod trakt;

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployMediaTrackerImportInput {
    /// The base url where the resource is present at
    api_url: String,
    /// An application token generated by an admin
    api_key: String,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployGoodreadsImportInput {
    // The RSS url that can be found from the user's profile
    rss_url: String,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployTraktImportInput {
    // The public username in Trakt.
    username: String,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployMovaryImportInput {
    // The CSV contents of the history file.
    history: String,
    // The CSV contents of the ratings file.
    ratings: String,
    // The CSV contents of the watchlist file.
    watchlist: String,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployMalImportInput {
    /// The anime export file path (uploaded via temporary upload).
    anime_path: String,
    /// The manga export file path (uploaded via temporary upload).
    manga_path: String,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployStoryGraphImportInput {
    // The CSV contents of the export file.
    export: String,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct StrongAppImportMapping {
    source_name: String,
    target_name: String,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployStrongAppImportInput {
    // The path to the CSV file in the local file system.
    export_path: String,
    mapping: Vec<StrongAppImportMapping>,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployMediaJsonImportInput {
    // The contents of the JSON export.
    export: String,
}

#[derive(Debug, InputObject, Serialize, Deserialize, Clone)]
pub struct DeployImportJobInput {
    pub source: ImportSource,
    pub media_tracker: Option<DeployMediaTrackerImportInput>,
    pub goodreads: Option<DeployGoodreadsImportInput>,
    pub trakt: Option<DeployTraktImportInput>,
    pub movary: Option<DeployMovaryImportInput>,
    pub mal: Option<DeployMalImportInput>,
    pub story_graph: Option<DeployStoryGraphImportInput>,
    pub strong_app: Option<DeployStrongAppImportInput>,
    pub media_json: Option<DeployMediaJsonImportInput>,
}

/// The various steps in which media importing can fail
#[derive(Debug, Enum, PartialEq, Eq, Copy, Clone, Serialize, Deserialize)]
pub enum ImportFailStep {
    /// Failed to get details from the source itself (for eg: MediaTracker, Goodreads etc.)
    ItemDetailsFromSource,
    /// Failed to get metadata from the provider (for eg: Openlibrary, IGDB etc.)
    MediaDetailsFromProvider,
    /// Failed to transform the data into the required format
    InputTransformation,
    /// Failed to save a seen history item
    SeenHistoryConversion,
    /// Failed to save a review/rating item
    ReviewConversion,
}

#[derive(
    Debug, SimpleObject, FromJsonQueryResult, Serialize, Deserialize, Eq, PartialEq, Clone,
)]
pub struct ImportFailedItem {
    lot: MetadataLot,
    step: ImportFailStep,
    identifier: String,
    error: Option<String>,
}

#[derive(Debug, SimpleObject, Serialize, Deserialize, Eq, PartialEq, Clone)]
pub struct ImportDetails {
    pub total: usize,
}

#[derive(Debug)]
pub struct ImportResult {
    collections: Vec<CreateOrUpdateCollectionInput>,
    media: Vec<ImportOrExportMediaItem>,
    failed_items: Vec<ImportFailedItem>,
    workouts: Vec<UserWorkoutInput>,
}

#[derive(
    Debug, SimpleObject, Serialize, Deserialize, FromJsonQueryResult, Eq, PartialEq, Clone,
)]
pub struct ImportResultResponse {
    pub import: ImportDetails,
    pub failed_items: Vec<ImportFailedItem>,
}

#[derive(Default)]
pub struct ImporterQuery;

#[Object]
impl ImporterQuery {
    /// Get all the import jobs deployed by the user.
    async fn import_reports(&self, gql_ctx: &Context<'_>) -> Result<Vec<import_report::Model>> {
        let service = gql_ctx.data_unchecked::<Arc<ImporterService>>();
        let user_id = service.user_id_from_ctx(gql_ctx).await?;
        service.import_reports(user_id).await
    }
}

#[derive(Default)]
pub struct ImporterMutation;

#[Object]
impl ImporterMutation {
    /// Add job to import data from various sources.
    async fn deploy_import_job(
        &self,
        gql_ctx: &Context<'_>,
        input: DeployImportJobInput,
    ) -> Result<String> {
        let service = gql_ctx.data_unchecked::<Arc<ImporterService>>();
        let user_id = service.user_id_from_ctx(gql_ctx).await?;
        service.deploy_import_job(user_id, input).await
    }
}

pub struct ImporterService {
    media_service: Arc<MiscellaneousService>,
    exercise_service: Arc<ExerciseService>,
}

impl AuthProvider for ImporterService {}

impl ImporterService {
    pub fn new(
        media_service: Arc<MiscellaneousService>,
        exercise_service: Arc<ExerciseService>,
    ) -> Self {
        Self {
            media_service,
            exercise_service,
        }
    }

    pub async fn deploy_import_job(
        &self,
        user_id: i32,
        mut input: DeployImportJobInput,
    ) -> Result<String> {
        if let Some(s) = input.media_tracker.as_mut() {
            s.api_url = s.api_url.trim_end_matches('/').to_owned()
        }
        let job = self
            .media_service
            .perform_application_job
            .clone()
            .push(ApplicationJob::ImportFromExternalSource(user_id, input))
            .await
            .unwrap();
        Ok(job.to_string())
    }

    pub async fn invalidate_import_jobs(&self) -> Result<()> {
        let all_jobs = ImportReport::find()
            .filter(import_report::Column::Success.is_null())
            .all(&self.media_service.db)
            .await?;
        for job in all_jobs {
            if Utc::now() - job.started_on > Duration::hours(24) {
                tracing::trace!("Invalidating job with id = {id}", id = job.id);
                let mut job: import_report::ActiveModel = job.into();
                job.success = ActiveValue::Set(Some(false));
                job.save(&self.media_service.db).await?;
            }
        }
        Ok(())
    }

    pub async fn import_reports(&self, user_id: i32) -> Result<Vec<import_report::Model>> {
        let reports = ImportReport::find()
            .filter(import_report::Column::UserId.eq(user_id))
            .order_by_desc(import_report::Column::StartedOn)
            .all(&self.media_service.db)
            .await
            .unwrap();
        Ok(reports)
    }

    pub async fn start_importing(&self, user_id: i32, input: DeployImportJobInput) -> Result<()> {
        match input.source {
            ImportSource::StrongApp => self.import_exercises(user_id, input).await,
            _ => self.import_media(user_id, input).await,
        }
    }

    #[instrument(skip(self, input))]
    async fn import_exercises(&self, user_id: i32, input: DeployImportJobInput) -> Result<()> {
        let db_import_job = self.start_import_job(user_id, input.source).await?;
        let import = match input.source {
            ImportSource::StrongApp => {
                strong_app::import(input.strong_app.unwrap(), &self.media_service.db).await?
            }
            _ => unreachable!(),
        };
        let details = ImportResultResponse {
            import: ImportDetails {
                total: import.workouts.len(),
            },
            failed_items: vec![],
        };
        for workout in import.workouts {
            self.exercise_service
                .create_user_workout(user_id, workout)
                .await
                .ok();
        }
        self.finish_import_job(db_import_job, details).await?;
        Ok(())
    }

    #[instrument(skip(self, input))]
    async fn import_media(&self, user_id: i32, input: DeployImportJobInput) -> Result<()> {
        let db_import_job = self.start_import_job(user_id, input.source).await?;
        let mut import = match input.source {
            ImportSource::MediaTracker => {
                media_tracker::import(input.media_tracker.unwrap()).await?
            }
            ImportSource::MediaJson => media_json::import(input.media_json.unwrap()).await?,
            ImportSource::Mal => mal::import(input.mal.unwrap()).await?,
            ImportSource::Goodreads => goodreads::import(input.goodreads.unwrap()).await?,
            ImportSource::Trakt => trakt::import(input.trakt.unwrap()).await?,
            ImportSource::Movary => movary::import(input.movary.unwrap()).await?,
            ImportSource::StoryGraph => {
                story_graph::import(
                    input.story_graph.unwrap(),
                    &self.media_service.get_openlibrary_service().await?,
                )
                .await?
            }
            _ => unreachable!(),
        };
        let preferences =
            partial_user_by_id::<UserWithOnlyPreferences>(&self.media_service.db, user_id)
                .await?
                .preferences;
        import.media = import
            .media
            .into_iter()
            .sorted_unstable_by_key(|m| {
                m.seen_history.len() + m.reviews.len() + m.collections.len()
            })
            .rev()
            .collect_vec();
        for col_details in import.collections.into_iter() {
            self.media_service
                .create_or_update_collection(user_id, col_details)
                .await?;
        }
        for (idx, item) in import.media.iter().enumerate() {
            tracing::debug!(
                "Importing media with identifier = {iden}",
                iden = item.source_id
            );
            let identifier = item.internal_identifier.clone().unwrap();
            let data = match identifier {
                ImportOrExportItemIdentifier::NeedsDetails(i) => {
                    self.media_service
                        .commit_media(item.lot, item.source, &i)
                        .await
                }
                ImportOrExportItemIdentifier::AlreadyFilled(a) => {
                    self.media_service.commit_media_internal(*a.clone()).await
                }
            };
            let metadata = match data {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!("{e:?}");
                    import.failed_items.push(ImportFailedItem {
                        lot: item.lot,
                        step: ImportFailStep::MediaDetailsFromProvider,
                        identifier: item.source_id.to_owned(),
                        error: Some(e.message),
                    });
                    continue;
                }
            };
            for seen in item.seen_history.iter() {
                let progress = if seen.progress.is_some() {
                    seen.progress
                } else {
                    Some(100)
                };
                match self
                    .media_service
                    .progress_update(
                        ProgressUpdateInput {
                            metadata_id: metadata.id,
                            progress,
                            date: seen.ended_on.map(|d| d.date_naive()),
                            show_season_number: seen.show_season_number,
                            show_episode_number: seen.show_episode_number,
                            podcast_episode_number: seen.podcast_episode_number,
                            change_state: None,
                        },
                        user_id,
                    )
                    .await
                {
                    Ok(_) => {}
                    Err(e) => import.failed_items.push(ImportFailedItem {
                        lot: item.lot,
                        step: ImportFailStep::SeenHistoryConversion,
                        identifier: item.source_id.to_owned(),
                        error: Some(e.message),
                    }),
                };
            }
            for review in item.reviews.iter() {
                if review.review.is_none() && review.rating.is_none() {
                    tracing::debug!("Skipping review since it has no content");
                    continue;
                }
                let rating = match preferences.general.review_scale {
                    UserReviewScale::OutOfFive => review.rating.map(|rating| rating / dec!(20)),
                    UserReviewScale::OutOfHundred => review.rating,
                };
                let text = review.review.clone().and_then(|r| r.text);
                let spoiler = review.review.clone().map(|r| r.spoiler.unwrap_or(false));
                let date = review.review.clone().map(|r| r.date);
                match self
                    .media_service
                    .post_review(
                        user_id,
                        PostReviewInput {
                            rating,
                            text,
                            spoiler,
                            date: date.flatten(),
                            metadata_id: Some(metadata.id),
                            show_season_number: review.show_season_number,
                            show_episode_number: review.show_episode_number,
                            podcast_episode_number: review.podcast_episode_number,
                            ..Default::default()
                        },
                    )
                    .await
                {
                    Ok(_) => {}
                    Err(e) => import.failed_items.push(ImportFailedItem {
                        lot: item.lot,
                        step: ImportFailStep::ReviewConversion,
                        identifier: item.source_id.to_owned(),
                        error: Some(e.message),
                    }),
                };
            }
            for col in item.collections.iter() {
                self.media_service
                    .create_or_update_collection(
                        user_id,
                        CreateOrUpdateCollectionInput {
                            name: col.to_string(),
                            ..Default::default()
                        },
                    )
                    .await?;
                self.media_service
                    .add_entity_to_collection(
                        user_id,
                        ChangeCollectionToEntityInput {
                            collection_name: col.to_string(),
                            entity_id: metadata.id,
                            entity_lot: EntityLot::Media,
                        },
                    )
                    .await
                    .ok();
            }
            tracing::debug!(
                "Imported item: {idx}/{total}, lot: {lot}, history count: {hist}, review count: {rev}, collection count: {col}",
                idx = idx + 1,
                total = import.media.len(),
                lot = item.lot,
                hist = item.seen_history.len(),
                rev = item.reviews.len(),
                col = item.collections.len(),
            );
        }
        self.media_service
            .deploy_recalculate_summary_job(user_id)
            .await
            .ok();
        tracing::debug!(
            "Imported {total} media items from {source}",
            total = import.media.len(),
            source = db_import_job.source
        );
        let details = ImportResultResponse {
            import: ImportDetails {
                total: import.media.len(),
            },
            failed_items: import.failed_items,
        };
        self.finish_import_job(db_import_job, details).await?;
        Ok(())
    }

    async fn start_import_job(
        &self,
        user_id: i32,
        source: ImportSource,
    ) -> Result<import_report::Model> {
        let model = import_report::ActiveModel {
            user_id: ActiveValue::Set(user_id),
            source: ActiveValue::Set(source),
            ..Default::default()
        };
        let model = model.insert(&self.media_service.db).await.unwrap();
        tracing::trace!("Started import job with id = {id}", id = model.id);
        Ok(model)
    }

    async fn finish_import_job(
        &self,
        job: import_report::Model,
        details: ImportResultResponse,
    ) -> Result<import_report::Model> {
        let mut model: import_report::ActiveModel = job.into();
        model.finished_on = ActiveValue::Set(Some(Utc::now()));
        model.details = ActiveValue::Set(Some(details));
        model.success = ActiveValue::Set(Some(true));
        let model = model.update(&self.media_service.db).await.unwrap();
        Ok(model)
    }
}
